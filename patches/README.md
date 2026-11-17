# SSH compatibility with Node 26

`ssh2+1.17.0.patch` replaces `v8::Context::GetIsolate()`, removed in Node 26,
with `v8::Isolate::GetCurrent()` at the six native crypto constructor
registration sites. It also removes the context variables made unnecessary
by that change.

The root postinstall hook applies this patch with `patch-package`, then runs
`npm rebuild ssh2` so a fresh installation compiles the corrected source.
SSH retains its JavaScript fallback when native build tools are unavailable.
The NAN override selects version 2.30.0 for both SSH crypto and cpu-features.

Desktop builds use SSH's JavaScript fallback and exclude both optional native
modules. Those binaries are built for the installation's Node 26 ABI, while
Electron bundles a different Node runtime. Disabling Electron's dependency
rebuild and excluding the host binaries keeps desktop packaging independent
of native compilers and avoids shipping incompatible native modules.

Keep SSH2 pinned to 1.17.0 while this patch is needed. When updating SSH2,
check whether the upstream release includes the fix and remove or regenerate
the patch before refreshing the lockfile.
