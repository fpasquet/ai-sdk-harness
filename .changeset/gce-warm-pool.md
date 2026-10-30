---
'ai-sdk-sandbox-gce': patch
---

The sandbox service takes `SANDBOX_PROFILE=cost|fast`, to trade how fast a sandbox starts against what the service costs at rest. `cost`, the default, is the service as it was: nothing runs but the sandboxes, and a sandbox from a template starts in some 35 to 40 s. `fast` starts one in a few seconds, for one machine of `SANDBOX_MACHINE_TYPE` per template used in the last 24 h and the egress proxy running all the time: the service keeps a machine booted from each template in use, which the next creation from that template takes as it is, booted or still booting, and makes the next one meanwhile. A machine that waited 24 h without a creation is deleted without a replacement: a template no longer used costs a day of its machine at most. See "Speed or cost" in the README.

The profile only sets the defaults of two settings, each its own variable: `SANDBOX_WARM_POOL`, how many machines are kept booted per template (`0`, `1` with `fast`), and `SANDBOX_PROXY_ALWAYS_ON`, which never stops the proxy's machine of `SANDBOX_PROXY_INSTANCE` once no sandbox runs (`false`, `true` with `fast`). With `fast` and `SANDBOX_PROXY_INSTANCE`, leave the lines of `SANDBOX_PROXY_IDLE_EXIT_MINUTES` out of the proxy's unit.

A sandbox taken from the pool keeps its machine's name, `sbx-pool-<hex>`, since Compute Engine cannot rename a running machine: its sandbox's name is on its label `ai-sdk-sandbox-name`. The service's role needs no new permission: it already has `compute.instances.setLabels`.
