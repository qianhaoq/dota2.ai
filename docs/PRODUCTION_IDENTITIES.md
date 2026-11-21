# PR2: separate production runtime and deployment identities

Scope: independent of other changes, originally audited at `4976b414`.
Upstream main updates are incorporated through normal merges, without rewriting
history. This PR supplies a migration tool, not a production migration. No cloud validation has been done.
The original compute account's Editor, Run Admin, Service Account User and
Artifact Writer grants are **not removed**. Detaching two consumers does not
retire that account or remove project Editor.

## Contract

`python3 scripts/identity/migrate.py --help` (Python stdlib only) is the entry
point. Every cloud operation goes through gcloud using the operator's existing
session. The tool never runs authentication commands, prints tokens, creates key
files, reads secret versions, downloads objects, runs a build, or deploys an image.
Default operation reads only and prints a sanitized before/after plan, preliminary
legacy inventory, and the exact proposed write argument arrays. It creates no
journal until `--apply`. Apply re-reads production; its first durable local write
records the original baseline before any cloud writes.

| New principal | Allow binding | Resource scope |
| --- | --- | --- |
| Web runtime | Secret Accessor | Each of deepseek-api-key, gemini-api-key, steam-web-api-key, opendota-api-key individually |
| Web runtime | Storage Object Admin | `aegis-assistant-488913-replay-facts-t348u` only |
| Web runtime | Cloud Run Invoker | `dota2-ai-replay-worker` only |
| Build/deploy | Cloud Run Developer | Existing `dota2-ai` only |
| Build/deploy | Service Account User | New web runtime SA only |
| Build/deploy | Artifact Registry Writer | `asia-east1/cloud-run-source-deploy` only |
| Build/deploy | Logs Writer | Project (existing inline build must use CLOUD_LOGGING_ONLY) |
| Build/deploy, optional | Storage Object Viewer | `aegis-assistant-488913_cloudbuild`, only with reviewed `--source-reader` |

Bucket-scoped Object Admin is intentional: the transaction store needs object
read/write/list/delete. Neither target receives Editor, Run Admin, Token Creator,
Cloud Build Admin, project-wide actAs, or project-wide artifact/storage roles.
Build receives no direct secret access. **Deploy is a trusted code boundary:**
its actAs permission lets it deploy code running as runtime, and that code can
read runtime secrets. This migration does not prevent that indirect access.

Cloud Run imports deployment images through its **Cloud Run service agent**, not
through the web runtime identity. The deployer also needs repository read access
(already included in its scoped Writer role). Do not add an unnecessary runtime
Artifact Registry grant based on the old runtime's Editor role. Before apply,
verify that the existing Cloud Run service agent retains `roles/run.serviceAgent`
with `artifactregistry.repositories.downloadArtifacts`, including any effective
IAM restrictions. This tool does not change or repair service-agent permissions.
See [Cloud Run deployment permissions and image import](https://docs.cloud.google.com/run/docs/deploying).
A real staging same-digest identity update remains required; read-only IAM
inspection is not a successful deployment test.

The inline global GitHub trigger, **not repository YAML**, is authoritative.
Only its `serviceAccount` is updated via `gcloud builds triggers update github
--service-account`. The full trigger except that field is fingerprinted, including
inline steps, GitHub settings, filters, substitutions and options. Cloud Run gets
`services update` with `--image` set to the exact immutable digest of the currently
serving Ready revision and `--service-account` set to the new runtime identity,
preserving the same image bytes. No env/traffic flags are emitted. This creates a
revision with the same configuration and image bytes and new runtime identity.
No existing IAM bindings or worker/preview invokers are removed.

## Operator prerequisites and permissions

Use a trusted, current gcloud installation and Python 3 on an operator workstation.
Do not grant operator rights to either application identity. The human operator
needs read access to project ancestry, project and resource IAM, SA metadata,
Run services/jobs/revisions, builds/triggers, Artifact Registry metadata, bucket
metadata and VM inventory. Apply additionally needs `iam.serviceAccounts.create`,
resource-specific `getIamPolicy`/`setIamPolicy` for the table above,
`resourcemanager.projects.setIamPolicy` for Logs Writer, Run service update and
actAs on the new runtime. Updating the trigger requires the operator's
`cloudbuild.builds.update` and actAs on the new build identity. Restoring old
identities requires actAs on the recorded old compute account too. The tool does
not grant these operator permissions or enable APIs.

IAM Analyzer needs `cloudasset.assets.analyzeIamPolicy`,
`cloudasset.assets.searchAllResources`, `cloudasset.assets.searchAllIamPolicies`,
`iam.roles.get` and `serviceusage.services.use` at the root audit scope, plus
Workspace `groups.read` when group expansion is necessary. Missing/incomplete
analysis fails closed. Use `organizations/NUMBER` for a parented project; use
`projects/623152404086` only if project ancestry confirms no organization.
The tool checks that scope against ancestry. New identity names must not already
exist; only accounts marked by this journal's migration ID can be resumed.
Unexpected conditional, inherited or expanded group grants outside the table
abort. Do not work around a failure by broadening target roles.

Preflight also refuses public worker IAM, missing legacy worker invocation,
changed secret refs, unsupported inline build shape/logging, and unsafe replay
bucket flags. All ordinary env values and feature flags are fingerprinted in
memory, including the complete container configuration; those values are represented only
by SHA-256 hashes. Nonsecret original image and resolved digest identifiers are
also recorded/output to make the same-bytes operation reviewable. The four secret refs must be exactly `latest`, `latest`,
`latest`, and OpenDota version `1` respectively. Secret values never enter the tool.

To preserve source image bytes, preflight reads the current serving Ready revision
with `gcloud run revisions describe REVISION --region=asia-east1` and uses its
`status.imageDigest`. It never resolves a mutable registry tag. The plan exposes
`sameBytesImage` and the exact `--image=...@sha256:...` update: a commit-tagged
template is canonicalized to the digest of bytes already serving, alongside the
identity change. Before and after every switch the resolved serving digest must
equal the journal baseline. An already pinned template must match that digest.
The original tag or that exact digest are the only accepted template images.

Only a single container is supported. Desired traffic must be a single untagged
100% latest-revision target; observed traffic must actually serve 100% from the
latest Ready revision. Normal planning/apply also requires latest-created to equal
latest-Ready and the service to be Ready. Split, pinned, tagged, ambiguous,
multi-container or missing-digest states fail closed. These checks have only been
exercised offline against sanitized shapes; no production verification or writes
are claimed. The inline trigger may name the service literally or through
`$_SERVICE_NAME` / `${_SERVICE_NAME}`; effective trigger substitutions override
inline build defaults and must resolve exactly to `dota2-ai`. Public Git build
source does not require `--source-reader`; that grant remains opt-in.

## Sequential migration

1. Arrange one operator and an exclusive maintenance window. Freeze pushes and
   all deployments/configuration/IAM writers. Do not disable or change the trigger
   with this tool. It checks for queued/working/pending global trigger builds on
   each preflight, but cannot lock out an external writer. Keep the freeze until
   postchecks finish. API propagation delays can cause a safe stop; retry after
   inspecting the recorded phase, never bypass checks.
2. Choose two **new** names. On the authorized operator workstation, plan:

   ```bash
   python3 scripts/identity/migrate.py \
     --runtime dota2-web-runtime-v2@aegis-assistant-488913.iam.gserviceaccount.com \
     --build dota2-web-deploy-v2@aegis-assistant-488913.iam.gserviceaccount.com \
     --audit-scope projects/623152404086 \
     --journal /private/operator/pr2-identity-journal.json
   ```

   Substitute the actual root organization scope when applicable. Inspect the
   plan, inventory, exact write commands and prerequisites. `--source-reader` is
   opt-in, only if an independently reviewed build needs source bucket objects;
   it must stay consistent on all subsequent runs. This is not a secret-reading
   requirement. Keep journals outside the repository.
3. After separate production write authorization, repeat the same command with:

   ```text
   --apply --acknowledge CHANGE-PRODUCTION-IDENTITIES
   ```

   A fresh preflight runs. The mode-0600 journal is atomically saved with original
   service/trigger accounts, worker account, image identifiers and nonsecret baseline
   fingerprints.
   It does not export service specs or plaintext env/substitution/IAM values.
   Accounts are created with a journal ownership marker. Grants are additive and
   idempotent. New runtime worker invocation is granted and verified **before**
   switching web. Web switches first, then the live inline trigger. Each mutation
   records a pending phase before execution. Each switch rechecks the baseline,
   readiness, IAM analysis and identity; final checks re-read all scoped grants.
4. Repeat the original read-only command with the same journal. Require the
   accounts to be new runtime/new deploy, no baseline drift, and the apply journal
   phase `verified`. All env/refs/image/traffic and unrelated IAM fingerprints must
   match, with only the explicit same-bytes image canonicalization allowed.
   Only generated template revision names, template annotations
   `run.googleapis.com/client-name` and `run.googleapis.com/client-version`,
   and template label `client.knative.dev/nonce` are excluded from service
   fingerprints. Other labels, annotations and the full substantive spec remain
   protected. Bucket response timestamps/etag/
   metageneration are excluded; configuration and flags are retained. Worker
   policy comparison excludes only the additive runtime invoker.
5. Independently verify application health and authorized worker invocation in
   the approved window. Do not fetch secret values as a test. A real main build
   is a separate authorized action, not performed by this migration tool. Check
   its logs and resulting identity before claiming deployment validation.
   Unfreeze only after the operator accepts the results.

A failure leaves the last pending/done phase on disk and leaves additive grants
in place. No automatic IAM cleanup or rollback occurs. Re-run the same apply
with the **same journal, names and options**: missing grants are re-applied,
completed switches are skipped. If account creation succeeded but the next
journal save failed, the account's migration description supports recovery.
Never adopt an unmarked existing identity or delete the journal to evade drift.
If a crash leaves `.tmp`, inspect the sanitized file and reconcile with the main
journal before removing the stale temporary file. Do not run two copies.

## Rollback

With the original journal, run the same command plus `--rollback` to plan only.
After rollback write authorization, add `--apply --acknowledge
CHANGE-PRODUCTION-IDENTITIES`. Rollback freshly checks IAM and all baseline
invariants, restores the trigger account first, then the web service account,
and verifies the original accounts/readiness. It does not deploy old code or
restore an old spec. It refuses rollback if env/image/traffic/build/worker/IAM
has drifted; reconcile that drift through a separately reviewed procedure.
It retains the new accounts and every additive grant, including worker invocation.
Their removal needs separate review. Journal phase becomes `rolled-back`.
Rollback also creates a web revision with the baseline serving digest and
original identity; it requires operator actAs on the original compute account.
A journal-backed rollback can proceed when a partial identity switch left the
service Ready=False: the latest Ready revision must still be Ready and serve
100%, its digest must equal the baseline, and all configuration/IAM invariants
must still match. Recovery never uses the failed attempted revision's image or
resolves a tag. Final rollback verification requires the service Ready again.
If serving traffic/digest or substantive configuration has drifted, or no Ready
revision remains, the tool refuses recovery. Keep the journal and deployment
freeze; an authorized operator must inspect revision metadata, reconcile the
drift and review an explicit recovery procedure before any separate writes.
Do not edit the journal or bypass the guard. A missing journal cannot be reconstructed by
assuming that production still matches these documented facts.

## Retirement and limitations

Inventory uses Cloud Asset Inventory to discover Run services/jobs, global and
regional triggers, and VMs, then reads each actual resource to flag legacy-SA
references without persisting configurations. This is a preliminary,
project-scoped inventory subject to CAI coverage/indexing. It does not prove
retirement safety: include older/tagged Run revisions, job executions, in-flight
builds, instance templates/MIGs, other projects, schedulers/functions, federation,
external systems and indirect impersonation in a broader inventory. Removing
legacy Editor/other grants needs that inventory, workload owners and explicit
approval. Dormant old revisions are not rewritten by an identity update.

No client-side migration can make independent APIs transactional. The maintenance
freeze is required: pre/post drift checks detect, but cannot prevent, concurrent
changes between reads and writes. IAM Analyzer is indexed/eventually consistent;
the tool additionally reads each touched resource policy directly and checks its
unchanged members, then verifies exact grants before switching. Organization
policies, deny policies, VPC controls, quota and service-agent configuration can
still prevent effective access. The tool never grants service-agent/admin rights
to work around that. No real cloud success is inferred from offline fixtures.

Reference contracts: [trigger identity-only update](https://docs.cloud.google.com/sdk/gcloud/reference/builds/triggers/update/github),
[IAM Analyzer CLI](https://docs.cloud.google.com/sdk/gcloud/reference/asset/analyze-iam-policy),
[Analyzer permissions and group expansion](https://docs.cloud.google.com/policy-intelligence/docs/analyze-iam-policies),
[custom Cloud Build identities](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts).

## Offline verification

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/identity -v
node --check server.js
npm test
npm run build
npx tsc --noEmit
```

The original blanket ban on `--image` in offline assertions was incorrect for
same-bytes canonicalization. Tests now require the exact baseline serving digest
in the complete service-update command, and reject repository, tag, serving digest,
env, secret-ref and traffic drift. They also cover both service substitution
syntaxes, only the permitted generated metadata drift, and Ready=False rollback
with fail-closed recovery guards. No tests are skipped or weakened to accept a
different code digest.

Tests use a stateful fake gcloud and synthetic offline fixtures; one executable
fake verifies subprocess failure redaction. No SDK or credentials are required.
Independent Codex Gate/human review and normal CI remain required before merge;
this work does not weaken tests or gates.
