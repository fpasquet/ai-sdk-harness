---
'ai-sdk-sandbox-gce': patch
---

The proxy's startup script in the README lets systemd start the proxy as its machine boots again, some 25 s before the startup script runs: a sandbox waited for the script since 0.3.0, about 60 s for a stopped proxy rather than 35 s. A condition of its unit (`ExecCondition`) only lets the proxy start at boot when it is the version the script pins, its new `VERSION` line: after a change of version, the script upgrades it and starts it, as 0.3.0 does. The script also restarts the network's resolver only when its settings change. Hand the new script to the proxy's machine (`gcloud compute instances add-metadata … --metadata-from-file=startup-script=proxy-startup.sh`).
