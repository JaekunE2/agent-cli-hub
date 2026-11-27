"""Hub cleanup worker: find duplicates / old versions / caches / old files and move them through a 2-stage trash.

The hub plugin (server.js) drives it and asks for approvals; this script only does file work and prints JSON.

Trash, per drive (moves are fast renames):  <drive>:\\.hub-trash\\
  stage1\\<date>\\<original path>   restorable; after stage1_days → stage2
  stage2\\<date>\\...               deleted only by `purge`, which the hub runs after an approval
  manifest.jsonl                    every move (original path, trash path, reason, size)

    python cleanup.py scan    --config C --reports DIR            → report <DIR>/<date>.json + .md, prints a summary
    python cleanup.py move    --config C --report FILE --level safe|confirm   → items of that level to stage1
    python cleanup.py age     --config C                           → stage1 days past stage1_days → stage2; prints purge-due days
    python cleanup.py purge   --config C --root X:\\.hub-trash --days d1,d2   (only after approval)
    python cleanup.py status  --config C                           → trash contents per drive / stage / day
    python cleanup.py restore --config C --text T                  → entries whose original path contains T go back

Config (JSON): min_age_days, stage1_days, stage2_days, protect (globs), hard_protect (path prefixes; ~/.claude is
always protected), artifact_stores (hub artifacts-store.json files: pinned outputs are never touched),
cluster_bytes ({"g": 1048576} for drives with big clusters), rules: [{name, type: duplicates|old_versions|old_files|dirs,
level: safe|confirm, roots | paths, min_mb, days, pattern, max_depth, children, why}].
"""
import argparse, fnmatch, hashlib, json, os, re, shutil, string, sys, time
from datetime import datetime, timedelta

ap = argparse.ArgumentParser()
ap.add_argument('cmd', choices=['scan', 'move', 'age', 'purge', 'status', 'restore'])
ap.add_argument('--config', required=True)
ap.add_argument('--reports'); ap.add_argument('--report'); ap.add_argument('--level')
ap.add_argument('--root'); ap.add_argument('--days'); ap.add_argument('--text')
A = ap.parse_args()
CFG = json.load(open(A.config, encoding='utf-8'))
NOW = time.time()
DAY = 86400
TODAY = datetime.now().strftime('%Y-%m-%d')


def norm(p): return os.path.normcase(os.path.abspath(p))


HARD_PROTECT = [norm(os.path.expanduser(os.path.join('~', '.claude')))] + [norm(x) for x in CFG.get('hard_protect', [])]


def _pinned_outputs():
    out = set()
    for f in CFG.get('artifact_stores', []):
        try:
            for e in json.load(open(f, encoding='utf-8')).values():
                for x in e.get('pinned', []): out.add(norm(x['path']))
        except (OSError, ValueError):
            pass
    return out


PINNED = _pinned_outputs()


def protected(p):
    n = norm(p)
    if n in PINNED or any(x.startswith(n + os.sep) for x in PINNED): return True  # a pinned file, or a folder holding one
    if any(n == x or n.startswith(x.rstrip(os.sep) + os.sep) for x in HARD_PROTECT): return True
    if os.sep + '.hub-trash' + os.sep in n + os.sep: return True
    return any(fnmatch.fnmatch(n, os.path.normcase(g)) for g in CFG.get('protect', []))


def old_enough(p, days):
    try: return NOW - os.path.getmtime(p) >= days * DAY
    except OSError: return False


def size_of(p):
    if os.path.isfile(p): return os.path.getsize(p)
    t = 0
    for r, _, fs in os.walk(p):
        for f in fs:
            try: t += os.path.getsize(os.path.join(r, f))
            except OSError: pass
    return t


def walk_files(root, max_depth=None):
    base = root.rstrip('\\/').count(os.sep)
    for r, ds, fs in os.walk(root):
        if protected(r): ds[:] = []; continue
        if max_depth is not None and r.count(os.sep) - base >= max_depth: ds[:] = []
        ds[:] = [d for d in ds if d not in ('.git', 'node_modules', '.hub-trash')]
        for f in fs: yield os.path.join(r, f)


def fhash(p, sample=False):
    h = hashlib.sha1(); s = os.path.getsize(p)
    with open(p, 'rb') as f:
        if sample:
            for off in (0, s // 2, max(0, s - (4 << 20))):
                f.seek(off); h.update(f.read(4 << 20))
        else:
            for b in iter(lambda: f.read(8 << 20), b''): h.update(b)
    return h.hexdigest()


# ---------------- scanners: each yields dict(path, reason, level, size) ----------------
def scan_duplicates(rule):
    by_size = {}
    for root in rule.get('roots', []):
        if not os.path.isdir(root): continue
        for p in walk_files(root):
            try: s = os.path.getsize(p)
            except OSError: continue
            if s >= rule.get('min_mb', 1) << 20 and old_enough(p, CFG.get('min_age_days', 3)) and not protected(p):
                by_size.setdefault(s, []).append(p)
    for s, ps in by_size.items():
        if len(ps) < 2: continue
        groups = {}
        for p in ps:
            try: groups.setdefault(fhash(p, sample=True), []).append(p)
            except OSError: pass
        for g in groups.values():
            if len(g) < 2: continue
            full = {}
            for p in g:
                try: full.setdefault(fhash(p), []).append(p)
                except OSError: pass
            for same in full.values():
                if len(same) < 2: continue
                keep = sorted(same, key=lambda x: (os.path.getmtime(x), len(x), x))[0]
                for p in same:
                    if p != keep:
                        yield {'path': p, 'reason': 'duplicate (kept: %s)' % keep, 'level': rule.get('level', 'safe'), 'size': s}


VERSION_RE = re.compile(r'(\.bak(\b|[-_].*)|\.orig$|\.old$)', re.I)


def scan_old_versions(rule):
    for root in rule.get('roots', []):
        if not os.path.isdir(root): continue
        for r, ds, fs in os.walk(root):
            if protected(r): ds[:] = []; continue
            ds[:] = [d for d in ds if d not in ('.git', 'node_modules', '.hub-trash')]
            for name in list(ds) + fs:
                p = os.path.join(r, name)
                is_backup_dir = name in ds and re.match(r'(backup|bak)[-_]?\d{6,}', name, re.I)
                if not (VERSION_RE.search(name) or is_backup_dir): continue
                if not old_enough(p, rule.get('days', 30)) or protected(p): continue
                yield {'path': p, 'reason': 'old version / backup (%d days)' % rule.get('days', 30), 'level': rule.get('level', 'confirm'), 'size': size_of(p)}
                if name in ds: ds.remove(name)


def scan_old_files(rule):
    for root in rule.get('roots', []):
        if not os.path.isdir(root): continue
        for p in walk_files(root, rule.get('max_depth')):
            if fnmatch.fnmatch(os.path.basename(p), rule.get('pattern', '*')) and old_enough(p, rule['days']) and not protected(p):
                yield {'path': p, 'reason': rule.get('why', 'older than %d days' % rule['days']), 'level': rule.get('level', 'safe'), 'size': os.path.getsize(p)}


def scan_dirs(rule):
    for d in rule.get('paths', []):
        if not os.path.exists(d) or protected(d): continue
        for c in (os.listdir(d) if rule.get('children') else [None]):
            q = os.path.join(d, c) if c else d
            if old_enough(q, rule.get('days', 0)) and not protected(q):
                yield {'path': q, 'reason': rule.get('why', 'cache'), 'level': rule.get('level', 'safe'), 'size': size_of(q)}


SCANNERS = {'duplicates': scan_duplicates, 'old_versions': scan_old_versions, 'old_files': scan_old_files, 'dirs': scan_dirs}
CLUSTER = {k.lower(): int(v) for k, v in CFG.get('cluster_bytes', {}).items()}


def alloc(p, size):
    c = CLUSTER.get(os.path.splitdrive(norm(p))[0][:1].lower(), 4096)
    return -(-size // c) * c if os.path.isfile(p) else size


def gb(b): return '%.2f GB' % (b / 1e9)


def scan():
    items, seen = [], set()
    for rule in CFG.get('rules', []):
        for it in SCANNERS[rule['type']](rule):
            n = norm(it['path'])
            if n in seen: continue
            seen.add(n); it['rule'] = rule.get('name', rule['type']); it['size'] = alloc(it['path'], it['size']); items.append(it)
    return items


# ---------------- trash ----------------
def trash_root(p): return os.path.join(os.path.splitdrive(norm(p))[0] + os.sep, '.hub-trash')


def log(root, rec):
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, 'manifest.jsonl'), 'a', encoding='utf-8') as f: f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def to_stage1(it):
    src = it['path']
    if not os.path.exists(src) or protected(src): return 'skip'
    root = trash_root(src)
    rel = os.path.splitdrive(norm(src))[1].lstrip('\\/')
    dst = os.path.join(root, 'stage1', TODAY, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try: os.replace(src, dst)
    except OSError:
        try: shutil.move(src, dst)
        except Exception as e2: return 'skip (%s)' % e2.__class__.__name__
    log(root, {'at': datetime.now().isoformat(timespec='seconds'), 'op': 'stage1', 'src': src, 'dst': dst, 'size': it['size'], 'reason': it['reason']})
    return 'moved'


def trash_roots():
    out = []
    for d in string.ascii_uppercase:
        r = '%s:\\.hub-trash' % d
        if os.path.isdir(r): out.append(r)
    return out


def days_in(d):
    return sorted(x for x in os.listdir(d) if re.match(r'^\d{4}-\d{2}-\d{2}$', x)) if os.path.isdir(d) else []


def out(obj): print(json.dumps(obj, ensure_ascii=False))


if A.cmd == 'scan':
    items = scan()
    os.makedirs(A.reports, exist_ok=True)
    json.dump(items, open(os.path.join(A.reports, TODAY + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    lines = ['# Hub cleanup %s' % TODAY, '']
    for lvl in ('safe', 'confirm'):
        sel = [i for i in items if i['level'] == lvl]
        lines.append('## %s — %d items, %s' % (lvl, len(sel), gb(sum(i['size'] for i in sel))))
        lines += ['- %s  `%s`  — %s' % (gb(i['size']), i['path'], i['reason']) for i in sorted(sel, key=lambda x: -x['size'])[:200]]
        lines.append('')
    open(os.path.join(A.reports, TODAY + '.md'), 'w', encoding='utf-8').write('\n'.join(lines))
    out({'date': TODAY, 'report': os.path.join(A.reports, TODAY + '.json'),
         **{lvl: {'count': len([i for i in items if i['level'] == lvl]), 'bytes': sum(i['size'] for i in items if i['level'] == lvl)} for lvl in ('safe', 'confirm')}})
elif A.cmd == 'move':
    items = [i for i in json.load(open(A.report, encoding='utf-8')) if i['level'] == A.level]
    moved = [i for i in items if to_stage1(i) == 'moved']
    out({'level': A.level, 'moved': len(moved), 'bytes': sum(i['size'] for i in moved), 'skipped': len(items) - len(moved)})
elif A.cmd == 'age':
    s1d, s2d = CFG.get('stage1_days', 14), CFG.get('stage2_days', 7)
    aged, due = [], []
    for root in trash_roots():
        s1, s2 = os.path.join(root, 'stage1'), os.path.join(root, 'stage2')
        for day in days_in(s1):
            if datetime.strptime(day, '%Y-%m-%d') <= datetime.now() - timedelta(days=s1d):
                os.makedirs(s2, exist_ok=True); os.replace(os.path.join(s1, day), os.path.join(s2, day))
                log(root, {'at': datetime.now().isoformat(timespec='seconds'), 'op': 'stage2', 'day': day}); aged.append({'root': root, 'day': day})
        d = [x for x in days_in(s2) if datetime.strptime(x, '%Y-%m-%d') <= datetime.now() - timedelta(days=s1d + s2d)]
        if d: due.append({'root': root, 'days': d, 'bytes': sum(size_of(os.path.join(s2, x)) for x in d)})
    out({'aged': aged, 'purgeDue': due})
elif A.cmd == 'purge':
    root = A.root
    if not root or not re.match(r'^[A-Za-z]:\\\.hub-trash$', root.rstrip('\\')): sys.exit('bad --root')
    done = []
    for d in (A.days or '').split(','):
        p = os.path.join(root, 'stage2', d)
        if re.match(r'^\d{4}-\d{2}-\d{2}$', d) and os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True); done.append(d)
            log(root, {'at': datetime.now().isoformat(timespec='seconds'), 'op': 'purged', 'day': d})
    out({'root': root, 'purged': done})
elif A.cmd == 'status':
    res = []
    for root in trash_roots():
        for st in ('stage1', 'stage2'):
            for day in days_in(os.path.join(root, st)):
                res.append({'root': root, 'stage': st, 'day': day, 'bytes': size_of(os.path.join(root, st, day))})
    out({'trash': res})
elif A.cmd == 'restore':
    n = []
    for root in trash_roots():
        mf = os.path.join(root, 'manifest.jsonl')
        if not os.path.exists(mf): continue
        for line in open(mf, encoding='utf-8'):
            r = json.loads(line)
            if r.get('op') != 'stage1' or (A.text or '').lower() not in r['src'].lower(): continue
            cand = [r['dst'], r['dst'].replace(os.sep + 'stage1' + os.sep, os.sep + 'stage2' + os.sep, 1)]
            src = next((c for c in cand if os.path.exists(c)), None)
            if src and not os.path.exists(r['src']):
                os.makedirs(os.path.dirname(r['src']), exist_ok=True); os.replace(src, r['src']); n.append(r['src'])
                log(root, {'at': datetime.now().isoformat(timespec='seconds'), 'op': 'restored', 'src': r['src']})
    out({'restored': n})
