# Koa Kommander

A Windows-first, dual-panel file manager focused on clear file details and direct file operations.

## Run

Install Node.js, then from this folder run:

```powershell
npm install
npm start
```

## Versioning

The About dialog displays `Major.Minor.Commit`: the major and minor numbers come from `package.json`, and the final number is the current Git commit count. Adjust the major and minor numbers in `package.json` manually when needed. Uncommitted changes do not affect the commit number; builds without Git metadata fall back to the `package.json` version.

## First milestone

- Two independent folder panels, initially opened to the user folder and its `Documents` folder when available.
- Details view shows the full name (including extension), size, and modified date. Icon view offers adjustable icon sizes.
- Copy and cut/paste with `Ctrl+C`, `Ctrl+X`, and `Ctrl+V`; delete with `Delete` (moves items to the Recycle Bin).
- Drag between panels to move; hold `Ctrl` while dropping to copy.
- Double-click opens folders in place and files with their Windows default app.
- New folder, drive navigation, and “Show in File Explorer” are available from each panel.

## Windows context menu

Right-click currently opens an in-app menu with the common file actions. Electron's menu API does not expose the actual Windows Explorer shell menu or third-party shell extensions. Matching that exact menu requires a small Windows native bridge to `IContextMenu`; that integration is not in this first milestone.
