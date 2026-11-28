"""Transcribe every recording in AUDIO_DIR that has no transcript yet in OUT_DIR (faster-whisper, local GPU or CPU).

    python stt_faster_whisper.py <audio_dir> <out_dir> [--model large-v3] [--device auto|cuda|cpu] [--language ko]

Writes <out_dir>/<recording file name>.txt with one "[mm:ss] text" line per segment ("(?)" marks low confidence).
Prints only counts and timings (the output may end up in shared queue logs), never transcript text.
Needs: pip install faster-whisper
"""
import argparse, os, sys, time

AUDIO = ('.m4a', '.mp3', '.wav', '.ogg', '.aac', '.amr', '.3gp', '.flac', '.opus')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio_dir'); ap.add_argument('out_dir')
    ap.add_argument('--model', default='large-v3'); ap.add_argument('--device', default='auto'); ap.add_argument('--language', default='ko')
    a = ap.parse_args()
    files = [f for f in sorted(os.listdir(a.audio_dir)) if f.lower().endswith(AUDIO)]
    todo = [f for f in files if not os.path.exists(os.path.join(a.out_dir, f + '.txt'))]
    print(f'{len(todo)} of {len(files)} recordings to transcribe', flush=True)
    if not todo: return 0
    from faster_whisper import WhisperModel
    device = a.device
    if device == 'auto':
        try:
            import ctranslate2
            device = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
        except Exception:
            device = 'cpu'
    model = WhisperModel(a.model, device=device, compute_type='float16' if device == 'cuda' else 'int8')
    os.makedirs(a.out_dir, exist_ok=True)
    for f in todo:
        t0 = time.time()
        segs, info = model.transcribe(os.path.join(a.audio_dir, f), language=a.language or None, vad_filter=True, beam_size=5)
        lines = []
        for s in segs:
            mm, ss = divmod(int(s.start), 60)
            low = ' (?)' if s.avg_logprob < -1.0 or s.no_speech_prob > 0.6 else ''
            lines.append(f'[{mm:02d}:{ss:02d}] {s.text.strip()}{low}')
        tmp = os.path.join(a.out_dir, f + '.txt.part')
        with open(tmp, 'w', encoding='utf-8') as fh: fh.write('\n'.join(lines) + '\n')
        os.replace(tmp, os.path.join(a.out_dir, f + '.txt'))
        dur = getattr(info, 'duration', 0) or 0
        print(f'done 1 file: {dur:.0f}s audio in {time.time() - t0:.0f}s on {device}', flush=True)
    return 0

if __name__ == '__main__':
    sys.exit(main())
