# Browser QC screenshots

Every UI story's QC task saves its screenshots as `specs/001-n8n-parity/qc/<US>/<what>.png`, where `<US>` is `US1`..`US16` and `<what>` is the short name the story's QC task gives (e.g. `qc/US6/editor-disabled.png`, `qc/US11/if-conditions.png`). Take them against the daemon-served dashboard on `:18310` or `pnpm -C dashboard dev` on `:18320`, at 1440x900, in the light theme unless the story is about theming, and list every file name in the story's PR body.
