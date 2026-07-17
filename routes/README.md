# Your routes folder

Drop your real ride files in here and they appear in the app automatically as
routes tagged **★ yours** — with the real track, distance and elevation read
straight from the file.

**Supported formats:** `.gpx`, `.fit`, and gzipped `.fit.gz` / `.gz`
(Garmin and Wahoo record native `.fit`; Strava's bulk export gives `.fit.gz`).

## How to get your rides as GPX (one download covers everything)

**Strava bulk export** pulls in everything you've synced from Garmin, Wahoo and Komoot:

1. Strava website → **Settings** → *My Account*
2. **"Download or Delete Your Account"** → *Request your archive*
3. You'll get an email with a `.zip`. Unzip it and copy the `activities` `.gpx`
   files (rides only) into this folder.

Per-platform alternatives (GPX or FIT both work):
- **Garmin Connect:** open an activity → ⚙️ gear → *Export to GPX* (or the
  original `.fit` from the data export)
- **Komoot:** open a Tour → *"⋯" → Export GPX*
- **Wahoo:** copy the `.fit` files from the ELEMNT, or use the Strava export above

## Telling the app about each file (manifest.json)

`manifest.json` is a list. Add one entry per file. Only `file` is required —
everything else is optional and auto-detected if left out:

```json
[
  {
    "file": "morning-mar-menor-loop.gpx",
    "name": "Saturday Mar Menor Loop",
    "type": "road",                       // road | gravel | path
    "time": "2",                          // 1 | 2 | day  (auto from distance if omitted)
    "diff": "Moderate",                   // auto from elevation if omitted
    "surface": "Coast roads + paseo",
    "summary": "Short card description.",
    "desc": "Longer description shown in the detail panel.",
    "source": "https://www.strava.com/activities/123456789"
  }
]
```

If you just paste the filenames in with no extra detail, the app still reads the
real track, distance and climb from the GPX and names it from the file's own
`<name>` tag. Tell Claude once your files are in and they'll be wired up.

> Note: the auto-import reads files through the local preview server. Open the
> app via the server (the **velo** preview), not by double-clicking the HTML,
> for the folder import to work. The manual **⬆ Upload GPX** button works either way.
