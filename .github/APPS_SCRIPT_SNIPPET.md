# Auto-apply trusted submissions via GitHub Actions

Add this to your Google Apps Script `doPost` function, after writing to the sheet.
You'll need a GitHub Personal Access Token (classic, `repo` scope) stored as a script property called `GITHUB_TOKEN`.

## Setup

1. In Apps Script: Project Settings (gear icon) > Script Properties
2. Add property: `GITHUB_TOKEN` = your GitHub PAT

## Code to add in doPost (after sheet write)

```javascript
// Trusted submitters whose data is auto-applied
var TRUSTED = ['Zimmy', 'Roma-Starkiller'];

if (data.type !== 'feedback' && TRUSTED.indexOf(data.submitterName) !== -1) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (token) {
    try {
      UrlFetchApp.fetch('https://api.github.com/repos/Zimmy-Tech/versetools/dispatches', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({
          event_type: 'accel-submission',
          client_payload: {
            submitterName: data.submitterName,
            shipClassName: data.shipClassName,
            shipName: data.shipName,
            date: data.date,
            accel: {
              accelFwd: data.accelFwd,
              accelAbFwd: data.accelAbFwd,
              accelRetro: data.accelRetro,
              accelAbRetro: data.accelAbRetro,
              accelStrafe: data.accelStrafe,
              accelAbStrafe: data.accelAbStrafe,
              accelUp: data.accelUp,
              accelAbUp: data.accelAbUp,
              accelDown: data.accelDown,
              accelAbDown: data.accelAbDown
            }
          }
        })
      });
    } catch (err) {
      Logger.log('GitHub dispatch failed: ' + err);
    }
  }
}
```

The `client_payload` nests accel values under an `accel` key to stay within GitHub's 10-property limit.
The workflow double-checks the trusted list server-side.
