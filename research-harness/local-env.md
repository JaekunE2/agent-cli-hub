<!-- Machine-specific rules, inserted as section 5 of each new project's CLAUDE.md.
     Edit this file to describe YOUR PC (GPU, disks, install locations, network). Placeholders: {{CCD}} {{HARNESS}} {{SKILLS}} {{NODE}} -->
- GPU: **shared with the user's other jobs. Run every GPU job through the hub's GPU queue**:
  `node {{CCD}} gpu run --mem <required memory, e.g. 12G> --est <expected time, e.g. 90m> --label <exp-id> -- <command>`
  (without `--est` the job can't be backfilled, so it waits longer). Check status with `node {{CCD}} gpu`.
  Run long training in the background with a log file; while it waits in the queue do other work or use `status=waiting`.
  Set the memory request to the actual peak plus a little headroom.
  **Never kill or interrupt a process you didn't start.**
- Installs: keep environments and caches off the system drive if it is small (conda envs, HF_HOME, PIP_CACHE_DIR).
- Overleaf: push only if the user wrote `overleaf_remote` in BRIEF/state.config. By default, write only in the local `paper/`.
