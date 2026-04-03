# Auto-apply trusted submissions via GitHub Actions

Add this to your Google Apps Script `doPost` function, after writing to the sheet.
You'll need a GitHub Personal Access Token with `repo` scope stored as a script property called `GITHUB_TOKEN`.

## Setup

1. In Apps Script: File > Project properties > Script properties
2. Add property: `GITHUB_TOKEN` = your GitHub PAT (repo scope)

## Code to add in doPost (after sheet write)

```javascript
// Trusted submitters whose data is auto-applied
var TRUSTED = ['Zimmy', 'Roma-Starkiller'];

if (data.type !== 'feedback' && TRUSTED.indexOf(data.submitterName) !== -1) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (token) {
    UrlFetchApp.fetch('https://api.github.com/repos/Zimmy-Tech/versetools/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        event_type: 'accel-submission',
        client_payload: data
      })
    });
  }
}
```

This triggers the `auto-accel.yml` workflow which updates the JSON files and commits automatically.
The workflow double-checks the trusted list server-side, so even if someone spoofs the request, untrusted names are rejected.
