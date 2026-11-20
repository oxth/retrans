# Retrans Preview changelog

The Figma plugin's own versions, separate from the Retrans app's. A push to `main` that touches the
plugin releases the newest version below if it hasn't been released yet (tag `figma-plugin-v<version>`).
To release a change, add a section for the new version at the top.

## [0.1.0] - 2026-11-20

### What's new

- **Preview drafts in your real frames.** Load a preview file from Retrans, select frames and click **Make preview copies**: the drafts go into copies next to the originals, which are never changed.
- **Spot text that doesn't fit.** Text that may overflow or uses a font that isn't installed is flagged. Mark each string **Fits** or **Too long**, with a note.
- **Send your checks back.** **Save results** (or **Copy results**) gives the translator a file to import into Retrans.
- **Live link with Retrans on the same computer.** Pair once with the code from Retrans (**Settings → Figma plugin**), then **Get drafts** and **Send to Retrans** without any files. The plugin only talks to the Retrans app on your own computer.
