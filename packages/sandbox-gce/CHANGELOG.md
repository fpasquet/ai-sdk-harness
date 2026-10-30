# ai-sdk-sandbox-gce

## 0.3.3

### Patch Changes

- 7afcb0c: The sandbox service takes `SANDBOX_PROFILE=cost|fast`, to trade how fast a sandbox starts against what the service costs at rest. `cost`, the default, is the service as it was: nothing runs but the sandboxes, and a sandbox from a template starts in some 35 to 40 s. `fast` starts one in a few seconds, for one machine of `SANDBOX_MACHINE_TYPE` per template used in the last 24 h and the egress proxy running all the time: the service keeps a machine booted from each template in use, which the next creation from that template takes as it is, booted or still booting, and makes the next one meanwhile. A machine that waited 24 h without a creation is deleted without a replacement: a template no longer used costs a day of its machine at most. See "Speed or cost" in the README.
  
  The profile only sets the defaults of two settings, each its own variable: `SANDBOX_WARM_POOL`, how many machines are kept booted per template (`0`, `1` with `fast`), and `SANDBOX_PROXY_ALWAYS_ON`, which never stops the proxy's machine of `SANDBOX_PROXY_INSTANCE` once no sandbox runs (`false`, `true` with `fast`). With `fast` and `SANDBOX_PROXY_INSTANCE`, leave the lines of `SANDBOX_PROXY_IDLE_EXIT_MINUTES` out of the proxy's unit.
  
  A sandbox taken from the pool keeps its machine's name, `sbx-pool-<hex>`, since Compute Engine cannot rename a running machine: its sandbox's name is on its label `ai-sdk-sandbox-name`. The service's role needs no new permission: it already has `compute.instances.setLabels`.

## 0.3.2

### Patch Changes

- b40ea5d: `prepareGceSandboxService({ url, auth })` has the service boot its egress proxy ahead of a sandbox, when it starts and stops it (`SANDBOX_PROXY_INSTANCE`), without waiting for it: call it as soon as a sandbox is likely to be asked for, and the sandbox finds the proxy up rather than waiting some 40 s for its machine. The service answers it at `POST /v1/prepare`; a service of an earlier version answers 404, which the client takes as nothing to do.
  
  Should no sandbox come, the proxy exits after `SANDBOX_PROXY_IDLE_EXIT_MINUTES` with no sandbox, with the exit code 100, on which the unit of the README stops its machine: set to 10 minutes there. The proxy never exits by itself without the variable: leave it out of the unit of a proxy always on.
- b40ea5d: The proxy's startup script in the README lets systemd start the proxy as its machine boots again, some 25 s before the startup script runs: a sandbox waited for the script since 0.3.0, about 60 s for a stopped proxy rather than 35 s. A condition of its unit (`ExecCondition`) only lets the proxy start at boot when it is the version the script pins, its new `VERSION` line: after a change of version, the script upgrades it and starts it, as 0.3.0 does. The script also restarts the network's resolver only when its settings change. Hand the new script to the proxy's machine (`gcloud compute instances add-metadata … --metadata-from-file=startup-script=proxy-startup.sh`).
- a9d2fe3: The sandbox service's image is published to Docker Hub with each release, `docker.io/fpasquet/ai-sdk-sandbox-gce:<version>`, with a provenance attestation: deploy it with `gcloud run deploy --image`, rather than writing a `Dockerfile` and having Cloud Build make it with an account of its own. The README deploys it so.
- b40ea5d: The client deletes a template's throwaway sandbox once the sandbox made from the template runs, rather than as soon as the template is saved. With `SANDBOX_PROXY_INSTANCE`, no sandbox ran in between: the service stopped the egress proxy, and the sandbox that followed waited a whole minute for it to boot again.

## 0.3.1

### Patch Changes

- f6225e5: The README pins `ai-sdk-sandbox-gce@0.3.0` in the service's Dockerfile, the proxy's startup script and the sandbox image, rather than `0.2.0`: the service of 0.3.0 makes the proxy forget the sandboxes whose machine no longer runs, which takes a proxy of the same version.
- a9476c5: The READMEs deploy the service with a build account of its own, `--build-service-account` granted `roles/run.builder`, rather than the Compute Engine default service account, which older projects grant `roles/editor`: whatever a build ran could then reach everything in the project, the agents' tokens included. The sandbox-gce README also has the roles inherited from the folder and the organization checked, since they read the machines' metadata as well.

## 0.3.0

### Minor Changes

- 4e7f6bc: The service makes the egress proxy forget the sandboxes whose machine no longer runs. A machine stopped or deleted outside the service, a Spot machine taken back, one stopped at `SANDBOX_MAX_RUN_HOURS` or from the console, left its credentials in the proxy's memory until the application stopped the sandbox or the proxy restarted. In the background of a creation or a resume, every `SANDBOX_RECONCILE_MINUTES` at most (10 by default, `0` for never), the service now compares what the proxy holds with the machines of the zone, and forgets each sandbox whose address no running machine holds, or another sandbox of the service holds now. A sandbox registered again meanwhile is kept, and so is one of another service sharing the proxy in the zone. The proxy lists its sandboxes at `GET /v1/sandboxes`, and `DELETE /v1/sandboxes/:name?serial=` only forgets the registration it listed; a proxy of an earlier version is left as it is: upgrade it with the service.
- 463a18e: BREAKING: on Cloud Run, the sandbox service refuses to start without `SANDBOX_SERVICE_TOKEN`. The token is the second lock beside Cloud Run's IAM: without it, a service deployed with `--allow-unauthenticated` by mistake would let anyone run commands in every sandbox. Set `SANDBOX_INSECURE_NO_TOKEN=true` to keep a service without a token; it then logs a warning at startup. Off Cloud Run, the token stays optional.
  
  The service also logs a warning at startup when `SANDBOX_ALLOWED_HOSTS` holds `*`: every sandbox may then reach any host over HTTPS, and send its files there.

### Patch Changes

- 6806a20: The client refuses a sandbox service URL in plain HTTP, but on the loopback (`localhost`, `127.0.0.1`, `[::1]`): every call carries the identity token and the service token, which a URL in `http://` would send in clear. A service on Cloud Run is always reached in HTTPS.
- ba16981: The agent of a sandbox gets a new token at each `stop()`. The token was derived from `SANDBOX_AGENT_SECRET` and the machine's name alone, so it stayed the same for the whole life of the sandbox, and for a sandbox deleted and made again under the same name. It now also covers a run drawn at random when the machine is made and each time the service stops it, kept beside the token in the instance metadata: a token read there once, by anyone allowed to read the project's machines, serves until the next stop. The agent reads its token as the machine boots, as before, so the sandbox image needs no rebuild. A machine made before keeps its token until its next stop. Stopping needs `compute.instances.setMetadata`, already in the service's role: without it, the machine keeps its token and the stop goes on, with a warning.
- d6c47a8: The egress proxy counts the bytes each sandbox sends out and receives, over every connection of its machine, refused ones included. It logs them when it forgets the sandbox (`box forgotten, having sent 12.3 MB out and received 450.0 MB`) and gives them, `sent` and `received`, for each sandbox at `GET /v1/sandboxes`. An allowed host is a way out for data: the count shows a sandbox that sent out far more than its task needs.
- e6503c5: The egress proxy only reaches global unicast IPv6 addresses (`2000::/3`), rather than every address outside a list of private ranges. IPv4-compatible addresses (`::169.254.169.254`), local-use NAT64 (`64:ff9b:1::/48`), Teredo (`2001::/32`), site-local (`fec0::/10`) and documentation addresses are refused, along with the private ranges refused already. None of them was reachable from a proxy on an IPv4-only network, as Google Cloud VPCs are by default. A dual-stack network could have reached them.
- 64cc3a4: The egress proxy caps the connections each sandbox holds open through it at once: 128 by default, `SANDBOX_PROXY_MAX_CONNECTIONS` to change it. One connection beyond the cap is cut, and the first one cut is logged. A single sandbox could otherwise take every socket of the proxy, and cut the network of all the others. The proxy's systemd unit in the README raises its open file limit to match (`LimitNOFILE=65536`): add the line to yours.
- ed2fe3d: The README spells out what the security model leaves to the deployment. An allowed host is a way out for the sandbox's files: keep `*` and wildcards on shared domains out of production. The agents' tokens sit in the machines' metadata, which `roles/viewer` and `roles/compute.viewer` read. A template is only ever made from a sandbox no agent ran in. Sandbox names must be random and checked against the user on the server. A machine stopped outside the service keeps its credentials in the proxy until the application stops it. Traffic inside the VPC is plain HTTP. The proxy's startup script and the sandbox image install Node.js and the Ops Agent from their signed apt repositories rather than by piping a script into a shell.
  
  The proxy's startup script starts the proxy itself, once its package is the pinned one, and no longer lets systemd start it at boot. After a change of version, systemd started the previous one first: the service registered its sandboxes with it, and the proxy forgot them as the script restarted it on the new version.
- d6de560: The egress proxy reads the ClientHello of every `CONNECT` tunnel, and cuts the tunnel unless the TLS names the host it was opened to (SNI). A sandbox allowed one host behind a CDN, such as `registry.npmjs.org` behind Cloudflare, could open a tunnel to it and then name any other site served by the same CDN, a server of its own included. A tunnel to an IP address must name no server. A client that sends something other than TLS through a tunnel is cut too.

## 0.2.2

### Patch Changes

- 40ccefb: A template whose image takes more than five minutes to save is no longer lost. Node.js's fetch gave up on the save call after five minutes, so the client removed the builder while Compute Engine was still making the image from its disk, and the session failed with `fetch failed`. When the call is cut on the way, by the network or by Cloud Run's front end, the client now asks the service for the template until it is ready, for up to 30 minutes, and removes the builder only after that. A refusal from the service is still reported at once.

## 0.2.1

### Patch Changes

- ec23275: Git over HTTPS takes the credentials brokered for its server, such as a repository of `ai-sdk-harness-workspace`. Its requests went through the proxy's TLS tunnel, which the proxy cannot read, so the server got the placeholder and refused the fetch. The agent now sends them to the proxy's routes, through a `url.<proxy>/https/.insteadOf https://` setting added after the command's own `GIT_CONFIG_*` entries. Build the sandbox image again with this version.
- bd8f6da: The proxy's startup script in the README upgrades the package when its pinned version changes, and restarts the proxy on it: it used to install the package only on a machine that had none, so a proxy kept its first version. The README says how to hand the new script to the machine.

## 0.2.0

### Minor Changes

- 4b95a30: `spawn({ command, stdin: true })` hands back a process with a writable `stdin` in a Cloud Run or a Compute Engine sandbox too, whose close is the end of the command's input. Each write reaches the service in a request of its own: what is written meanwhile leaves with the next one, and a request that fails on the way is sent again, the service writing nothing twice.
  
  BREAKING: the client and the service speak version 2 of their protocol, which a service of an earlier version refuses. Deploy the sandbox service with this version of the package; for Compute Engine, build the sandbox image and the proxy's again with it too.

## 0.1.1

### Patch Changes

- 6f37b21: Follow the `spawn()` of `@ai-sdk/provider-utils` 5.0.70, which a sandbox session had to implement to type-check with it. `spawn({ command, stdin: true })` hands back a process with a writable `stdin`, whose close is the end of the command's input, in a Docker Sandbox, a microsandbox and an srt sandbox; without `stdin`, standard input stays closed and the process has no `stdin`. A Cloud Run or Compute Engine sandbox refuses `stdin: true` before the command starts, as the contract asks of a sandbox without it: their service carries no input to a process yet.

## 0.1.0

### Minor Changes

- First release: Compute Engine sandboxes for AI SDK harness agents. Each sandbox is a virtual machine of its own, Docker and Docker Compose included, with no external address, no service account and no way out but an egress proxy that keeps the credentials outside. `createGceNetworkSandboxSession()` and `resumeGceNetworkSandboxSession()` speak the protocol of `ai-sdk-sandbox-cloud-run` to a sandbox service you deploy on Cloud Run (`ai-sdk-sandbox-gce serve`), which drives the machines; the package also ships the egress proxy (`ai-sdk-sandbox-gce proxy`) and the agent of the sandbox image (`ai-sdk-sandbox-gce agent`). `stop()` stops the machine and keeps its disk, and `stop()` and `destroy()` return within seconds, Compute Engine finishing on its own; templates are saved as images. Spot machines (`SANDBOX_SPOT`) are created or started as standard ones when the zone has no Spot capacity left, unless `SANDBOX_SPOT_FALLBACK=false`. `SANDBOX_MAX_RUNNING` caps the sandboxes running at once. `SANDBOX_MAX_RUN_HOURS` has Compute Engine stop a machine after so long, and `SANDBOX_PROXY_INSTANCE` lets the service start the egress proxy with the first sandbox and stop it with the last. Each sandbox picks its image among those the service offers (`image`, `SANDBOX_IMAGES`), one per toolchain say, and an image lacking Node.js or git, which every harness needs, fails the creation with `GceSandboxImageError`.
