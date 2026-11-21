#!/usr/bin/env python3
"""Identity-only production migration. No API tokens, keys or secret versions are read."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

PROJECT = 'aegis-assistant-488913'
NUMBER = '623152404086'
REGION = 'asia-east1'
WEB = 'dota2-ai'
WORKER = 'dota2-ai-replay-worker'
TRIGGER = '0a392e9a-9a47-4dd1-8e20-d42ab0c3720a'
LEGACY = NUMBER + '-compute@developer.gserviceaccount.com'
BUCKET = PROJECT + '-replay-facts-t348u'
SOURCE = PROJECT + '_cloudbuild'
REPO = 'cloud-run-source-deploy'
SECRETS = {'deepseek-api-key': 'latest', 'gemini-api-key': 'latest',
           'steam-web-api-key': 'latest', 'opendota-api-key': '1'}
ACK = 'CHANGE-PRODUCTION-IDENTITIES'


class Unsafe(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise Unsafe(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Gcloud:
    def __call__(self, args):
        # Never echo stderr: CLI errors can include API response content/env values.
        project_flag = [] if any(a.startswith(('--project=', '--organization=')) for a in args) else ['--project=' + PROJECT]
        format_flag = [] if any(a.startswith('--format=') for a in args) else ['--format=json']
        p = subprocess.run(['gcloud', *args, *project_flag, *format_flag, '--quiet'],
                           capture_output=True, text=True, check=False)
        require(p.returncode == 0, 'gcloud operation failed (output suppressed); inspect phase and retry safely')
        try:
            return json.loads(p.stdout) if p.stdout.strip() else {}
        except ValueError:
            raise Unsafe('Invalid gcloud JSON (output suppressed)') from None


def run_args(name):
    return ['run', 'services', 'describe', name, '--region=' + REGION]


def trigger_args():
    return ['builds', 'triggers', 'describe', TRIGGER, '--region=global']


def account(service):
    return service['spec']['template']['spec']['serviceAccountName']


def trigger_account(trigger):
    return trigger['serviceAccount'].split('/')[-1]


def service_fingerprint(service, image_digest):
    spec = copy.deepcopy(service['spec'])
    spec['template']['spec'].pop('serviceAccountName', None)
    spec['template']['spec']['containers'][0]['image'] = image_digest
    # Cloud Run generates a new revision name for an identity update.
    spec['template'].get('metadata', {}).pop('name', None)
    annotations = spec['template'].get('metadata', {}).get('annotations', {})
    for key in ('run.googleapis.com/client-name', 'run.googleapis.com/client-version'):
        annotations.pop(key, None)
    labels = spec['template'].get('metadata', {}).get('labels', {})
    labels.pop('client.knative.dev/nonce', None)
    return digest(spec)


def trigger_fingerprint(trigger):
    value = copy.deepcopy(trigger)
    value.pop('serviceAccount', None)
    return digest(value)


def worker_fingerprint(worker):
    return digest(worker['spec'])


def ready(service):
    return any(c.get('type') == 'Ready' and c.get('status') == 'True'
               for c in service.get('status', {}).get('conditions', []))


def grants(runtime, build, source_reader=False):
    """(CLI resource prefix, canonical IAM resource, role, member email)."""
    run_resource = lambda name: f'//run.googleapis.com/projects/{PROJECT}/locations/{REGION}/services/{name}'
    result = [(['secrets', 'add-iam-policy-binding', secret],
               f'//secretmanager.googleapis.com/projects/{NUMBER}/secrets/{secret}',
               'roles/secretmanager.secretAccessor', runtime) for secret in SECRETS]
    result += [(['storage', 'buckets', 'add-iam-policy-binding', 'gs://' + BUCKET],
                '//storage.googleapis.com/' + BUCKET, 'roles/storage.objectAdmin', runtime),
               (['run', 'services', 'add-iam-policy-binding', WORKER, '--region=' + REGION],
                run_resource(WORKER), 'roles/run.invoker', runtime),
               (['run', 'services', 'add-iam-policy-binding', WEB, '--region=' + REGION],
                run_resource(WEB), 'roles/run.developer', build),
               (['iam', 'service-accounts', 'add-iam-policy-binding', runtime],
                f'//iam.googleapis.com/projects/{PROJECT}/serviceAccounts/{runtime}',
                'roles/iam.serviceAccountUser', build),
               (['artifacts', 'repositories', 'add-iam-policy-binding', REPO, '--location=' + REGION],
                f'//artifactregistry.googleapis.com/projects/{PROJECT}/locations/{REGION}/repositories/{REPO}',
                'roles/artifactregistry.writer', build),
               (['projects', 'add-iam-policy-binding', PROJECT],
                f'//cloudresourcemanager.googleapis.com/projects/{PROJECT}', 'roles/logging.logWriter', build),
               ]
    if source_reader:
        result.append((['storage', 'buckets', 'add-iam-policy-binding', 'gs://' + SOURCE],
                       '//storage.googleapis.com/' + SOURCE, 'roles/storage.objectViewer', build))
    return result


def canonical(resource):
    # APIs may return project number or project ID, and SA unique ID or email.
    return resource.replace('/projects/' + NUMBER + '/', '/projects/' + PROJECT + '/').replace(
        '/projects/' + NUMBER, '/projects/' + PROJECT)


class Migration:
    def __init__(self, cloud, runtime, build, scope, source_reader=False):
        self.cloud, self.runtime, self.build, self.scope = cloud, runtime, build, scope
        pattern = r'[a-z][a-z0-9-]{4,28}[a-z0-9]@' + re.escape(PROJECT) + r'\.iam\.gserviceaccount\.com'
        require(re.fullmatch(pattern, runtime) and re.fullmatch(pattern, build), 'Use dedicated project service account emails')
        require(runtime != build and LEGACY not in (runtime, build), 'Identities must be distinct')
        require(re.fullmatch(r'(organizations|projects)/[a-zA-Z0-9-]+', scope), 'Invalid audit scope')
        self.bindings = grants(runtime, build, source_reader)

    def inventory(self):
        # CAI discovers locations without relying on a configured gcloud default region.
        found = self.cloud(['asset', 'search-all-resources', '--scope=projects/' + NUMBER,
                            '--asset-types=run.googleapis.com/Service,run.googleapis.com/Job,'
                            'cloudbuild.googleapis.com/BuildTrigger,compute.googleapis.com/Instance'])
        resources = []
        for item in found:
            name, kind = item['name'], item['assetType']
            parts = name.split('/')
            leaf = parts[-1]
            if kind in ('run.googleapis.com/Service', 'run.googleapis.com/Job'):
                region = parts[parts.index('locations') + 1]
                noun = 'services' if kind.endswith('/Service') else 'jobs'
                args = ['run', noun, 'describe', leaf, '--region=' + region,
                        '--format=json(metadata.name,spec.template.spec.serviceAccountName,spec.template.spec.template.spec.serviceAccountName)']
            elif kind == 'cloudbuild.googleapis.com/BuildTrigger':
                region = parts[parts.index('locations') + 1] if 'locations' in parts else 'global'
                args = ['builds', 'triggers', 'describe', leaf, '--region=' + region,
                        '--format=json(name,serviceAccount)']
            elif kind == 'compute.googleapis.com/Instance':
                zone = parts[parts.index('zones') + 1]
                args = ['compute', 'instances', 'describe', leaf, '--zone=' + zone,
                        '--format=json(name,serviceAccounts.email)']
            else:
                raise Unsafe('Unknown inventory asset type')
            detail = self.cloud(args)
            resources.append({'name': name, 'usesLegacy': LEGACY in json.dumps(detail)})
        return resources

    def audit(self, existing):
        # IAM Analyzer expands group grants and inherited policies. Partial analysis fails closed.
        # Audit scope must be the root ancestor, checked against project ancestry below.
        for email in (self.runtime, self.build):
            scope_type, scope_id = self.scope.split('/')
            scope_flag = '--organization=' if scope_type == 'organizations' else '--project='
            data = self.cloud(['asset', 'analyze-iam-policy', scope_flag + scope_id,
                               '--identity=serviceAccount:' + email, '--expand-groups', '--expand-roles', '--show-response'])
            analysis = data.get('mainAnalysis', {})
            require(analysis.get('fullyExplored') is True and data.get('fullyExplored', True) is True and
                    not analysis.get('nonCriticalErrors') and not data.get('nonCriticalErrors'),
                    'IAM analysis incomplete; cannot verify target privileges')
            allowed = {(canonical(res), role) for _, res, role, member in self.bindings if member == email}
            observed = set()
            for result in analysis.get('analysisResults', []):
                require(result.get('fullyExplored', True) is True, 'Incomplete IAM binding analysis')
                binding = result['iamBinding']
                resource = canonical(result['attachedResourceFullName'])
                for target, data in self.accounts().items():
                    if target in (self.runtime, self.build):
                        resource = resource.replace('/serviceAccounts/' + str(data.get('uniqueId', 'UNSET')),
                                                    '/serviceAccounts/' + target)
                require(not binding.get('condition') and (resource, binding['role']) in allowed,
                        'Unexpected target IAM grant; refusing overprivileged identity')
                observed.add((resource, binding['role']))
            require(existing or not observed, 'New target already has IAM privileges')
        return True

    def policy_invariants(self):
        accounts = self.accounts()
        fingerprints = {}
        for args, resource, role, email in self.bindings:
            if args[:2] == ['iam', 'service-accounts'] and args[3] not in accounts:
                policy = {'bindings': []}
            else:
                policy = self.cloud([a.replace('add-iam-policy-binding', 'get-iam-policy') for a in args])
            retained = []
            for binding in copy.deepcopy(policy.get('bindings', [])):
                if binding['role'] == role and not binding.get('condition'):
                    binding['members'] = [member for member in binding.get('members', [])
                                          if member != 'serviceAccount:' + email]
                if binding.get('members'):
                    binding['members'].sort()
                    retained.append(binding)
            fingerprints[resource] = digest(sorted(retained, key=lambda b: json.dumps(b, sort_keys=True)))
        return fingerprints

    def snapshot(self, recovery=None):
        c = self.cloud
        project = c(['projects', 'describe', PROJECT])
        require(str(project['projectNumber']) == NUMBER, 'Project number mismatch')
        ancestry = c(['projects', 'get-ancestors', PROJECT])
        root = ancestry[-1]
        expected_scope = ('organizations/' if root['type'] == 'organization' else 'projects/') + str(root['id'])
        require(self.scope == expected_scope, 'Audit scope must cover root project ancestor')
        service, trigger, worker = c(run_args(WEB)), c(trigger_args()), c(run_args(WORKER))
        require(ready(worker), 'Worker must be Ready')
        require(ready(service) or recovery is not None, 'Web must be Ready outside journal-backed rollback')
        containers = service['spec']['template']['spec']['containers']
        require(len(containers) == 1, 'Multi-container image resolution requires separate review')
        traffic = service['spec'].get('traffic', [])
        require(len(traffic) == 1 and traffic[0].get('latestRevision') is True and
                traffic[0].get('percent') == 100 and not traffic[0].get('tag'),
                'Pinned/split/tagged traffic requires separate revision migration review')
        status = service['status']
        serving = status.get('traffic', [])
        revision_name = status.get('latestReadyRevisionName')
        require(revision_name and len(serving) == 1 and
                serving[0].get('revisionName') == revision_name and
                serving[0].get('percent') == 100 and not serving[0].get('tag'),
                'Serving traffic must be 100% on the latest Ready revision')
        if ready(service):
            require(status.get('latestCreatedRevisionName') == revision_name,
                    'Latest created revision is not serving')
        revision = c(['run', 'revisions', 'describe', revision_name, '--region=' + REGION])
        require(revision.get('metadata', {}).get('name') == revision_name and ready(revision),
                'Serving revision is not Ready')
        image_digest = revision.get('status', {}).get('imageDigest', '')
        require(re.fullmatch(r'[^@\s]+@sha256:[a-f0-9]{64}', image_digest),
                'Serving revision has no immutable image digest')
        image = containers[0]['image']
        # Never resolve a mutable registry tag: only use Cloud Run's serving revision digest.
        repository = image.split('@')[0] if '@' in image else image.rsplit(':', 1)[0]
        require(repository == image_digest.split('@')[0], 'Serving image repository mismatch')
        if '@' in image:
            require(image == image_digest, 'Template digest differs from serving bytes')
        if recovery:
            require(image_digest == recovery['imageDigest'], 'Recovery serving bytes drift')
        active = c(['builds', 'list', '--region=global',
                    '--filter=buildTriggerId=' + TRIGGER + ' AND (status=QUEUED OR status=WORKING OR status=PENDING)'])
        require(not active, 'Active production builds; freeze pushes and wait before migration')
        require(account(worker) not in (LEGACY, self.runtime, self.build), 'Worker must retain its dedicated identity')
        refs = []
        for container in service['spec']['template']['spec']['containers']:
            for env in container.get('env', []):
                if 'valueFrom' in env:
                    ref = env['valueFrom']['secretKeyRef']
                    refs.append((ref['name'], ref['key']))
        require(sorted(refs) == sorted(SECRETS.items()), 'Unexpected secret references')
        require(not trigger.get('disabled') and trigger.get('github', {}).get('push') == {'branch': '^main$'},
                'Unexpected GitHub trigger filter')
        require(trigger.get('build', {}).get('options', {}).get('logging') == 'CLOUD_LOGGING_ONLY',
                'Custom build SA requires existing CLOUD_LOGGING_ONLY; other logging needs separate review')
        steps = trigger.get('build', {}).get('steps', [])
        substitutions = {**trigger.get('build', {}).get('substitutions', {}),
                         **trigger.get('substitutions', {})}
        target = steps[2].get('args', [])[3] if len(steps) == 3 and len(steps[2].get('args', [])) > 3 else None
        if target in ('$_SERVICE_NAME', '${_SERVICE_NAME}'):
            target = substitutions.get('_SERVICE_NAME')
        require(len(steps) == 3 and 'docker' in steps[0].get('name', '') and
                steps[0].get('args', [None])[0] == 'build' and
                'docker' in steps[1].get('name', '') and steps[1].get('args', [None])[0] == 'push' and
                steps[2].get('args', [])[:3] == ['run', 'services', 'update'] and target == WEB and
                any(a.startswith('--image') for a in steps[2]['args']), 'Unexpected inline deployment build')
        require(not trigger.get('filename') and not trigger.get('build', {}).get('availableSecrets') and
                not trigger.get('build', {}).get('secrets'),
                'Unexpected build secret/config source')
        bucket = c(['storage', 'buckets', 'describe', 'gs://' + BUCKET])
        require(bucket.get('uniform_bucket_level_access') is True and
                bucket.get('public_access_prevention') == 'enforced', 'Unsafe replay bucket flags')
        for field in ('metageneration', 'update_time', 'updated', 'etag'):
            bucket.pop(field, None)
        source = c(['storage', 'buckets', 'describe', 'gs://' + SOURCE])
        for field in ('metageneration', 'update_time', 'updated', 'etag'):
            source.pop(field, None)
        repo = c(['artifacts', 'repositories', 'describe', REPO, '--location=' + REGION])
        require(repo.get('format') == 'DOCKER', 'Artifact repository is not Docker')
        worker_policy = c(['run', 'services', 'get-iam-policy', WORKER, '--region=' + REGION])
        require(not any(m in ('allUsers', 'allAuthenticatedUsers') for b in worker_policy.get('bindings', [])
                        for m in b.get('members', [])), 'Worker is public')
        require(any(b['role'] == 'roles/run.invoker' and 'serviceAccount:' + LEGACY in b['members']
                    for b in worker_policy.get('bindings', [])), 'Legacy worker invocation missing')
        retained_policy = copy.deepcopy(worker_policy.get('bindings', []))
        for binding in retained_policy:
            binding['members'] = [m for m in binding.get('members', []) if m != 'serviceAccount:' + self.runtime]
        retained_policy = [b for b in retained_policy if b.get('members')]
        # Config/policy hashes plus nonsecret image identifiers and workload accounts only;
        # no env plaintext, secret values, build substitutions, or unrelated IAM principals.
        return {'iam': self.policy_invariants(), 'service': service_fingerprint(service, image_digest),
                'imageDigest': image_digest, 'templateImage': image, 'trigger': trigger_fingerprint(trigger),
                'worker': worker_fingerprint(worker), 'workerPolicy': digest(retained_policy),
                'bucket': digest(bucket), 'source': digest(source), 'repo': digest(repo),
                'webAccount': account(service), 'triggerAccount': trigger_account(trigger),
                'workerAccount': account(worker)}

    def accounts(self):
        return {a['email']: a for a in self.cloud(['iam', 'service-accounts', 'list'])}

    def validate(self, baseline, current):
        require(current['templateImage'] in (baseline['templateImage'], baseline['imageDigest']), 'Template image drift')
        for key in ('imageDigest', 'iam', 'service', 'trigger', 'worker', 'workerPolicy', 'bucket', 'source', 'repo', 'workerAccount'):
            require(baseline[key] == current[key], 'Baseline drift: ' + key)
        require(current['webAccount'] in (baseline['webAccount'], self.runtime) and
                current['triggerAccount'] in (baseline['triggerAccount'], self.build), 'Identity drift')

    def operations(self, baseline, rollback=False, migration_id=None):
        if rollback:
            return [self.switch_trigger(baseline['triggerAccount']), self.switch_web(baseline['webAccount'], baseline['imageDigest'])]
        commands = [['iam', 'service-accounts', 'create', e.split('@')[0],
                     '--description=identity-migration-' + str(migration_id)]
                    for e in (self.runtime, self.build) if e not in self.accounts()]
        commands += [args + ['--role=' + role, '--member=serviceAccount:' + member, '--condition=None']
                     for args, _, role, member in self.bindings]
        return commands + [self.switch_web(self.runtime, baseline['imageDigest']), self.switch_trigger(self.build)]

    def switch_web(self, email, image_digest):
        return ['run', 'services', 'update', WEB, '--region=' + REGION,
                '--image=' + image_digest, '--service-account=' + email]

    def switch_trigger(self, email):
        return ['builds', 'triggers', 'update', 'github', TRIGGER, '--region=global',
                '--service-account=projects/' + PROJECT + '/serviceAccounts/' + email]

    def execute(self, journal, save, rollback=False):
        baseline = journal['baseline']
        snapshot = lambda: self.snapshot(baseline if rollback else None)
        self.validate(baseline, snapshot())
        self.audit(True)
        if rollback:
            # Only identity restoration. Additive permissions deliberately remain.
            for phase, cmd in zip(('rollback-trigger', 'rollback-web'), self.operations(baseline, True)):
                self.validate(baseline, snapshot())
                journal['phase'] = phase + ':pending'; save(journal)
                self.cloud(cmd)
                self.validate(baseline, snapshot())
                journal['phase'] = phase + ':done'; save(journal)
            final = self.snapshot()
            require(final['webAccount'] == baseline['webAccount'] and
                    final['triggerAccount'] == baseline['triggerAccount'], 'Rollback verification failed')
        else:
            for email in (self.runtime, self.build):
                accounts = self.accounts()
                if email not in accounts:
                    journal['phase'] = 'create:' + email + ':pending'; save(journal)
                    self.cloud(['iam', 'service-accounts', 'create', email.split('@')[0],
                                '--description=identity-migration-' + journal['migrationId']])
                target = self.accounts()[email]
                require(target.get('description') == 'identity-migration-' + journal['migrationId'] and
                        not target.get('disabled'), 'Conflicting or disabled target account')
            for index, (args, _, role, member) in enumerate(self.bindings):
                self.validate(baseline, snapshot())
                self.audit(True)
                journal['phase'] = 'grant:' + str(index) + ':pending'; save(journal)
                self.cloud(args + ['--role=' + role, '--member=serviceAccount:' + member, '--condition=None'])
                journal['phase'] = 'grant:' + str(index) + ':done'; save(journal)
            self.verify_grants()
            for phase, command, key, target in (
                ('switch-web', self.switch_web(self.runtime, baseline['imageDigest']), 'webAccount', self.runtime),
                ('switch-trigger', self.switch_trigger(self.build), 'triggerAccount', self.build),
            ):
                current = snapshot(); self.validate(baseline, current); self.audit(True)
                if current[key] != target:
                    journal['phase'] = phase + ':pending'; save(journal)
                    self.cloud(command)
                current = snapshot(); self.validate(baseline, current)
                require(current[key] == target, 'Identity postcheck failed')
                journal['phase'] = phase + ':done'; save(journal)
            self.verify_grants(); self.audit(True)
        journal['phase'] = 'rolled-back' if rollback else 'verified'; save(journal)

    def verify_grants(self):
        for args, _, role, email in self.bindings:
            read = [a.replace('add-iam-policy-binding', 'get-iam-policy') for a in args]
            policy = self.cloud(read)
            require(any(b['role'] == role and not b.get('condition') and
                        'serviceAccount:' + email in b.get('members', []) for b in policy.get('bindings', [])),
                    'Missing required scoped grant')
        # No target may mint tokens/actAs via an incoming account policy, except deploy actAs runtime.
        for email in (self.runtime, self.build):
            policy = self.cloud(['iam', 'service-accounts', 'get-iam-policy', email])
            for binding in policy.get('bindings', []):
                require(email == self.runtime and binding['role'] == 'roles/iam.serviceAccountUser' and
                        not binding.get('condition') and binding['members'] == ['serviceAccount:' + self.build],
                        'Unexpected target service account impersonation policy')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--build', required=True)
    parser.add_argument('--audit-scope', required=True, help='Root organization, or project for an unparented project')
    parser.add_argument('--journal', type=Path, required=True)
    parser.add_argument('--source-reader', action='store_true', help='Reviewed build source-bucket read requirement')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--acknowledge')
    args = parser.parse_args()
    require(not args.apply or args.acknowledge == ACK, 'Apply requires explicit production write acknowledgement')
    migration = Migration(Gcloud(), args.runtime, args.build, args.audit_scope, args.source_reader)
    identity = {'runtime': args.runtime, 'build': args.build, 'scope': args.audit_scope, 'project': PROJECT, 'sourceReader': args.source_reader, 'version': 2}
    require(not args.journal.is_symlink(), 'Journal cannot be a symlink')
    journal = json.loads(args.journal.read_text()) if args.journal.exists() else None
    require(not args.rollback or journal is not None, 'Rollback requires original journal')
    current = migration.snapshot(journal['baseline'] if args.rollback and journal else None)
    if journal:
        require(journal['identity'] == identity, 'Journal identity/config mismatch')
        require(journal['baseline']['webAccount'] == LEGACY and journal['baseline']['triggerAccount'] == LEGACY,
                'Invalid original identity baseline')
        migration.validate(journal['baseline'], current)
        for email, account_data in migration.accounts().items():
            if email in (args.runtime, args.build):
                require(account_data.get('description') == 'identity-migration-' + journal['migrationId'] and
                        not account_data.get('disabled'), 'Conflicting target identity; do not adopt existing accounts')
    else:
        require(current['webAccount'] == LEGACY and current['triggerAccount'] == LEGACY, 'Unexpected original identity')
        accounts = migration.accounts()
        require(args.runtime not in accounts and args.build not in accounts, 'Target already exists; select NEW identities')
        migration.audit(False)
        journal = {'identity': identity, 'baseline': current, 'phase': 'planned', 'migrationId': uuid.uuid4().hex}
    migration.audit(True)
    inventory = migration.inventory()
    print(json.dumps({'before': current, 'after': {
        'webAccount': journal['baseline']['webAccount'] if args.rollback else args.runtime,
        'triggerAccount': journal['baseline']['triggerAccount'] if args.rollback else args.build},
        'sameBytesImage': {'from': current['templateImage'], 'to': journal['baseline']['imageDigest'],
                           'source': 'Cloud Run serving Ready revision; no registry tag resolution'},
        'inventory': inventory, 'dryRunWrites': migration.operations(journal['baseline'], args.rollback, journal['migrationId'])}, indent=2))
    if not args.apply:
        return  # Default plan performs no filesystem or cloud writes.
    def save(value):
        path = args.journal
        require(not path.is_symlink(), 'Journal cannot be a symlink')
        temporary = path.with_suffix(path.suffix + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    save(journal)  # Baseline durably recorded BEFORE any cloud writes.
    migration.execute(journal, save, args.rollback)
    print(json.dumps({'phase': journal['phase']}))


if __name__ == '__main__':
    try:
        main()
    except (Unsafe, KeyError, ValueError, TypeError, IndexError, OSError) as error:
        # Never print cloud data or Python tracebacks that might expose env values.
        print('Stopped safely: ' + (str(error) if isinstance(error, Unsafe) else 'invalid state or local I/O failure'), file=sys.stderr)
        sys.exit(1)
