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

It never builds the template: until the first sandbox made from it, only the proxy boots. One machine at a time: a template whose pool holds one, running or booting, gets none more, however many calls. A prepared machine no creation took is deleted by the next creation or preparation that meets it once it waited 15 minutes; should none come, `SANDBOX_MAX_RUN_HOURS` is what stops it, so set it when you prepare. A service of an earlier version ignores the template and boots the proxy only.
