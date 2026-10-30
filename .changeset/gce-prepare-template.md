---
'ai-sdk-sandbox-gce': patch
---

`prepareGceSandboxService()` takes the sandbox's `template` (with its `setup` and `image`), and the service then boots a machine from it ahead of the sandbox, beside the egress proxy, with the `cost` profile too: the creation that follows takes it, in a few seconds rather than some 25 s for its own machine to boot. A person reading a summary before launching a sandbox gets it at once, for no fixed cost.

```ts
void prepareGceSandboxService({
  url,
  auth: 'metadata',
  template: await agent.getSandboxTemplate(),
}).catch(() => undefined);
```

It never builds the template: until the first sandbox made from it, only the proxy boots. One machine at a time: a template whose pool holds one, running or booting, gets none more, however many calls. A prepared machine no creation took powers itself off 16 minutes after its boot: its agent does so, unless a sandbox took it, whether a call comes or not, and the service deletes it as the next creation or preparation meets it once it waited 15 minutes. Rebuild the sandbox image with this version for the agent's bound to apply: a machine of an older image keeps only the service's, and should no call come, `SANDBOX_MAX_RUN_HOURS` is what stops it, so set it when you prepare. The service no longer stops the egress proxy while a prepared machine waits for its sandbox, and a preparation starts a proxy the last sandbox was just stopping once it has stopped: the sandbox that takes the machine no longer waits for the proxy to boot again. A service of an earlier version ignores the template and boots the proxy only.
