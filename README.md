# CodeBuddy Code Agent Extension for Tutti

Declarative Tutti integration for `@tencent-ai/codebuddy-code@2.121.2` through standard ACP.

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

The signed manifest references the transparent conversation-row mask through `icon`, the colored shared Agent identity through `sidebarIcon`, and the home poster through `heroImage`. Tutti uses the sidebar artwork in the Provider Rail, conversation headers, Message Center, and mentions while the primary icon remains the mask-safe conversation glyph. The sidebar artwork crops the left 560×560 mark from CodeBuddy's official [WorkBuddy black lockup](https://download.codebuddy.cn/web/login/3fd66a24cf9c21a985b4fad85eb86b2c5bd5c974/assets/workbuddy-black.f5a45906.svg); it excludes the adjacent wordmark and remains local in the signed package. Keep each packaged image at or below 256 KiB and replace it deliberately when branding changes.

## Release

The repository-owned `.github/workflows/release.yml` builds, signs, and uploads immutable releases using `scripts/release/`. Configure the documented GitHub OIDC/AWS variables and the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret before dispatch. For new infrastructure, deploy `infra/aws/agent-extension-release-infrastructure.yaml`.
