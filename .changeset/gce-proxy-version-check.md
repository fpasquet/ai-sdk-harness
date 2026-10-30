---
'ai-sdk-sandbox-gce': patch
---

The condition of the proxy's unit in the README reads the installed version from the package's `package.json`, rather than with `npm ls --global`: npm took some 20 s to start on the proxy's machine as it booted, and the proxy waited for it, some 54 s for a stopped proxy rather than 35 s. Hand the new script to the proxy's machine (`gcloud compute instances add-metadata … --metadata-from-file=startup-script=proxy-startup.sh`).
