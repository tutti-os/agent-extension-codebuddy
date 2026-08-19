# CodeBuddy Code Agent Extension for Tutti

Declarative Tutti integration for `@tencent-ai/codebuddy-code@2.121.2` through standard ACP.

The Extension declares an optional Provider-owned account-usage companion at
`packages/account-usage-probe`. The signed Extension remains data-only; Tutti
installs and verifies the companion independently from the ACP runtime. The
companion owns CodeBuddy configuration, native-session lookup, credential
refresh races, trusted account endpoints, pagination, and response conversion.
It emits only the closed `tutti.agent.account-usage.v2` snapshot. Exact Credits
are returned only when an unfiltered request collects every page and an explicit
total proves completeness; otherwise the account type remains visible with an
unavailable quota state.

## Validate

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
```

Verify the real ACP runtime without sending a paid prompt:

```sh
python3 scripts/probe_acp_runtime.py --cwd /path/to/project -- codebuddy --acp
```

The signed manifest references the colored shared Agent identity through `icon`, the transparent conversation-row glyph through `maskIcon`, and the home poster through `heroImage`. The primary artwork crops the left 560×560 mark from CodeBuddy's official [WorkBuddy black lockup](https://download.codebuddy.cn/web/login/3fd66a24cf9c21a985b4fad85eb86b2c5bd5c974/assets/workbuddy-black.f5a45906.svg); it excludes the adjacent wordmark and remains local in the signed package. Keep each packaged image at or below 256 KiB and replace it deliberately when branding changes.

## Release

Publish and verify the exact account-usage companion version first with
`.github/workflows/publish-account-usage-probe.yml`. The Extension release
workflow refuses to publish while that npm package is unavailable.

The repository-owned `.github/workflows/release.yml` builds, signs, and uploads immutable releases using `scripts/release/`. Configure the documented GitHub OIDC/AWS variables and the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret before dispatch. For new infrastructure, deploy `infra/aws/agent-extension-release-infrastructure.yaml`.
