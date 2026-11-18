# Sample consent recordings (generated, no real call audio)

| File | What it shows |
|---|---|
| `PRV01_EXAMPLE-LEAD-001_20261117T093000Z.wav` | Naming convention `<SOURCE CODE>_<provider's lead id>_<UTC timestamp>.wav`. Matched to the lead whose `external_lead_id` is `EXAMPLE-LEAD-001`. |
| `SIM-example-recording-ref.wav` | Named by the `recording_ref` the provider sent with the lead. |
| `PRV01_UNKNOWN-LEAD_20261117T093500Z.wav` | Valid audio that matches no lead: appears under **Consent Recordings → Recording files** as *Not matched*. |
| `not-really-audio.wav` | A text file with a `.wav` name: rejected by the content check (*Rejected*). |

Each file is a short generated tone (8 kHz, 16-bit mono).

Use them to test uploads to the SFTP server (see `docs/RAILWAY_DEPLOYMENT.md`).
