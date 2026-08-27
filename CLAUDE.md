## Design System
Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match `DESIGN.md`.

## Deploy Configuration (configured by /setup-deploy)
- Platform: Delegate Docker Swarm origin via `ssh 8170-server`, fronted by SWAG on `ssh delegate-server`
- Production URL: https://www.bonary.xyz
- Deploy workflow: Manual commit-pinned release using `deploy/staging/publish.sh`
- Deploy status command: `bash deploy/staging/status.sh 8170-server` plus `docker service ls --filter name=nginx-system_swag` on `delegate-server`
- Merge method: No implicit merge; deploy the current approved commit
- Project type: Multi-service web application and background runtime
- Post-deploy health check: `bash deploy/staging/smoke.sh 8170-server`

### Custom deploy hooks
- Pre-merge: `pnpm verify && pnpm build`
- Deploy trigger: `bash deploy/staging/publish.sh 8170-server`
- Deploy status: `bash deploy/staging/status.sh 8170-server`
- Health check: `bash deploy/staging/smoke.sh 8170-server`
