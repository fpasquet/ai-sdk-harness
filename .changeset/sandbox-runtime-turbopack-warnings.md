---
'ai-sdk-sandbox-runtime': patch
---

A Next.js application built with Turbopack no longer warns about `ai-sdk-sandbox-runtime`. Next.js bundles a workspace dependency even when `serverExternalPackages` lists it, and Turbopack then reported that it could not resolve the package names this one finds at run time, and that copying the supervisor and starting srt would trace the whole project into the server output. These three calls now carry a `turbopackIgnore` comment; what they do is unchanged.
