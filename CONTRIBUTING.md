# Contributing

## Developer Certificate of Origin (DCO) 1.1

Every contribution to this project is made under the Developer Certificate of
Origin, version 1.1 (https://developercertificate.org/). By submitting a patch
you certify, for each commit, that:

> Developer Certificate of Origin
> Version 1.1
>
> Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
>
> Everyone is permitted to copy and distribute verbatim copies of this
> license document, but changing it is not allowed.
>
> Developer's Certificate of Origin 1.1
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I
>     have the right to submit it under the open source license
>     indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best
>     of my knowledge, is covered under an appropriate open source
>     license and I have the right under that license to submit that
>     work with modifications, whether created in whole or in part
>     by me, under the same open source license (unless I am
>     permitted to submit under a different license), as indicated
>     in the file; or
>
> (c) The contribution was provided directly to me by some other
>     person who certified (a), (b) or (c) and I have not modified
>     it.
>
> (d) I understand and agree that this project and the contribution
>     are public and that a record of the contribution (including all
>     personal information I submit with it, including my sign-off) is
>     maintained indefinitely and may be redistributed consistent with
>     this project or the open source license(s) involved.

Sign off every commit with `git commit -s`, which adds a
`Signed-off-by: Name <email>` trailer certifying the above.

## Ground rules

- **Zero npm dependencies.** Every import must be a `node:*` builtin. The only
  external runtime dependency is the `rg` binary used by the grep tool.
- Node >= 24, pure ESM (`"type": "module"`). No transpiler, no build step.
- Before pushing: `npm run check && npm test` must be green.
- The event log is the interface contract. If you change an event shape, bump
  the fixture (`fixtures/events.v1.jsonl`) and the conformance test together.
- Never commit an event log (`logs/`, `*.jsonl` are gitignored). Attestations
  quote sha256 hashes of canonical transcripts, never log contents.
