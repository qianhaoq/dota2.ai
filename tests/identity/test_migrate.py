"""Offline stateful fake gcloud; no credentials, network, SDK, or personal principals."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[2] / 'scripts/identity/migrate.py'
spec = importlib.util.spec_from_file_location('migrate', MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# Fictitious identifiers: production ones are passed as flags, never committed.
TEST_PROJECT, TEST_NUMBER, TEST_TRIGGER = 'example-project-1', '100000000001', '00000000-0000-4000-8000-000000000001'
m.configure(TEST_PROJECT, TEST_NUMBER, TEST_TRIGGER)
RUNTIME = 'web-runtime-v2@' + m.PROJECT + '.iam.gserviceaccount.com'
BUILD = 'web-deploy-v2@' + m.PROJECT + '.iam.gserviceaccount.com'
WORKER = 'replay-worker@' + m.PROJECT + '.iam.gserviceaccount.com'


def service(email):
    return {'spec': {'template': {'spec': {'serviceAccountName': email, 'containers': [
        {'image': 'asia-east1-docker.pkg.dev/project/repo/web@sha256:' + 'a' * 64, 'env': [
            {'name': 'FLAG', 'value': 'NONSECRET_ENV_MUST_NOT_BE_STORED'},
            *[{'name': 'SECRET_' + str(i), 'valueFrom': {'secretKeyRef': {'name': name, 'key': version}}}
              for i, (name, version) in enumerate(m.SECRETS.items())]]}]}},
        'traffic': [{'latestRevision': True, 'percent': 100} ]},
        'status': {'conditions': [{'type': 'Ready', 'status': 'True'}],
                   'latestReadyRevisionName': 'fixture-ready', 'latestCreatedRevisionName': 'fixture-ready',
                   'traffic': [{'revisionName': 'fixture-ready', 'latestRevision': True, 'percent': 100}]}}


class FakeGcloud:
    def __init__(self):
        self.web, self.worker = service(m.LEGACY), service(WORKER)
        self.trigger = {'id': m.TRIGGER, 'serviceAccount': 'projects/' + m.PROJECT + '/serviceAccounts/' + m.LEGACY,
                        'github': {'owner': 'fixture-org', 'name': 'fixture-repo', 'push': {'branch': '^main$'}},
                        'substitutions': {'_SAFE': 'fixture'}, 'includedFiles': ['**'], 'ignoredFiles': ['docs/**'],
                        'build': {'options': {'logging': 'CLOUD_LOGGING_ONLY'}, 'steps': [
                            {'name': 'gcr.io/cloud-builders/docker', 'args': ['build', '-t', 'image', '.']},
                            {'name': 'gcr.io/cloud-builders/docker', 'args': ['push', 'image']},
                            {'name': 'gcr.io/google.com/cloudsdktool/cloud-sdk',
                             'args': ['run', 'services', 'update', m.WEB, '--image=image', '--labels=fixture=yes']}]}}
        self.revision = {'metadata': {'name': 'fixture-ready'}, 'status': {
            'conditions': [{'type': 'Ready', 'status': 'True'}],
            'imageDigest': self.web['spec']['template']['spec']['containers'][0]['image']}}
        self.accounts = {}
        self.policies = {}
        self.worker_policy = {'bindings': [{'role': 'roles/run.invoker', 'members': [
            'serviceAccount:' + m.LEGACY, 'serviceAccount:preview@fixture.iam.gserviceaccount.com']}]}
        self.calls, self.writes = [], []
        self.fail = None
        self.incomplete = False
        self.extra_analysis = []

    def key(self, args):
        for prefix, resource, _, _ in m.grants(RUNTIME, BUILD, True):
            if args == [x.replace('add-iam-policy-binding', 'get-iam-policy') for x in prefix] or args == prefix:
                return resource
        return 'SA:' + args[3]

    def __call__(self, args):
        args = list(args)
        self.calls.append(args)
        write = any(x in args for x in ('create', 'update', 'add-iam-policy-binding'))
        if write:
            self.writes.append(args)
            if self.fail and self.fail(args):
                raise m.Unsafe('injected failure')
        if args[:3] == ['projects', 'describe', m.PROJECT]:
            return {'projectNumber': m.NUMBER}
        if args[:2] == ['projects', 'get-ancestors']:
            return [{'type': 'project', 'id': m.NUMBER}]
        if args[:3] == ['run', 'revisions', 'describe']:
            return copy.deepcopy(self.revision)
        if args[:3] == ['run', 'services', 'describe']:
            return copy.deepcopy(self.web if args[3] == m.WEB else self.worker)
        if args[:3] == ['builds', 'triggers', 'describe']:
            return copy.deepcopy(self.trigger)
        if args[:3] == ['storage', 'buckets', 'describe']:
            return {'name': args[3], 'uniform_bucket_level_access': True, 'public_access_prevention': 'enforced'}
        if args[:3] == ['artifacts', 'repositories', 'describe']:
            return {'format': 'DOCKER', 'name': m.REPO}
        if args[:3] == ['iam', 'service-accounts', 'list']:
            return list(copy.deepcopy(self.accounts).values())
        if args[:3] == ['iam', 'service-accounts', 'create']:
            email = args[3] + '@' + m.PROJECT + '.iam.gserviceaccount.com'
            self.accounts[email] = {'email': email, 'description': args[4].split('=', 1)[1], 'uniqueId': str(len(self.accounts) + 100)}
            return {}
        if args[:2] == ['asset', 'search-all-resources']:
            return [{'name': '//cloudbuild.googleapis.com/projects/' + m.PROJECT + '/locations/asia-east1/triggers/' + m.TRIGGER,
                     'assetType': 'cloudbuild.googleapis.com/BuildTrigger'}]
        if args[:2] == ['asset', 'analyze-iam-policy']:
            email = next(a.split(':', 1)[1] for a in args if a.startswith('--identity='))
            results = []
            for resource, policy in self.policies.items():
                for b in policy['bindings']:
                    if 'serviceAccount:' + email in b['members']:
                        results.append({'attachedResourceFullName': resource, 'iamBinding': b})
            return {'mainAnalysis': {'fullyExplored': not self.incomplete,
                                     'analysisResults': results + self.extra_analysis}}
        if 'get-iam-policy' in args:
            if args[:4] == ['run', 'services', 'get-iam-policy', m.WORKER]:
                return copy.deepcopy(self.worker_policy)
            return copy.deepcopy(self.policies.get(self.key(args), {'bindings': []}))
        if 'add-iam-policy-binding' in args:
            prefix = [a for a in args if not a.startswith(('--role=', '--member=', '--condition='))]
            resource = self.key(prefix)
            policy = self.worker_policy if prefix[:4] == ['run', 'services', 'add-iam-policy-binding', m.WORKER] else self.policies.setdefault(resource, {'bindings': []})
            role = next(a.split('=', 1)[1] for a in args if a.startswith('--role='))
            member = next(a.split('=', 1)[1] for a in args if a.startswith('--member='))
            binding = next((b for b in policy['bindings'] if b['role'] == role), None)
            if binding is None:
                binding = {'role': role, 'members': []}; policy['bindings'].append(binding)
            if member not in binding['members']:
                binding['members'].append(member)
            self.policies[resource] = policy
            return {}
        if args[:3] == ['run', 'services', 'update']:
            self.web['spec']['template']['spec']['serviceAccountName'] = args[-1].split('=', 1)[1]
            self.web['spec']['template']['spec']['containers'][0]['image'] = next(a.split('=', 1)[1] for a in args if a.startswith('--image='))
            self.web['status']['conditions'][0]['status'] = 'True'
            self.web['status']['latestCreatedRevisionName'] = self.web['status']['latestReadyRevisionName']
            return {}
        if args[:4] == ['builds', 'triggers', 'update', 'github']:
            self.trigger['serviceAccount'] = args[-1].split('=', 1)[1]
            return {}
        if 'list' in args:
            if args[:3] == ['builds', 'locations', 'list']:
                return [{'locationId': 'global'}, {'locationId': m.REGION}]
            return []
        raise AssertionError('Unsupported fake command: ' + repr(args))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.cloud = FakeGcloud()
        self.tool = m.Migration(self.cloud, RUNTIME, BUILD, 'projects/' + m.NUMBER)
        self.saved = []

    def journal(self):
        return {'baseline': self.tool.snapshot(), 'migrationId': 'offline-test', 'phase': 'planned'}

    def save(self, j):
        self.saved.append(copy.deepcopy(j))

    def apply(self):
        j = self.journal()
        self.tool.execute(j, self.save)
        return j

    def cli(self, *flags):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal.json'
            argv = ['migrate', '--project', TEST_PROJECT, '--project-number', TEST_NUMBER, '--trigger', TEST_TRIGGER, '--runtime', RUNTIME, '--build', BUILD, '--audit-scope', 'projects/' + m.NUMBER,
                    '--journal', str(path), *flags]
            with patch.object(sys, 'argv', argv), patch.object(m, 'Gcloud', return_value=self.cloud), patch('sys.stdout', new_callable=io.StringIO) as output:
                m.main()
            return path.exists(), output.getvalue()

    def test_default_plan_no_cloud_or_local_writes_no_values(self):
        exists, output = self.cli()
        self.assertFalse(exists)
        self.assertEqual(self.cloud.writes, [])
        self.assertNotIn('NONSECRET_ENV_MUST_NOT_BE_STORED', output)
        self.assertIn('dryRunWrites', output)
        self.assertIn('/locations/asia-east1/triggers/', output)
        self.assertFalse(any('versions' in cmd or 'access' in cmd for cmd in self.cloud.calls))

    def test_ack_required_before_even_reads(self):
        with self.assertRaises(m.Unsafe):
            self.cli('--apply')
        self.assertEqual(self.cloud.calls, [])

    def test_apply_scoped_grants_and_preservation(self):
        before_web, before_trigger = copy.deepcopy(self.cloud.web), copy.deepcopy(self.cloud.trigger)
        j = self.apply()
        self.assertEqual(j['phase'], 'verified')
        before_web['spec']['template']['spec']['serviceAccountName'] = RUNTIME
        before_trigger['serviceAccount'] = 'projects/' + m.PROJECT + '/serviceAccounts/' + BUILD
        self.assertEqual(before_web, self.cloud.web)
        self.assertEqual(before_trigger, self.cloud.trigger)
        self.assertEqual(m.account(self.cloud.worker), WORKER)
        members = self.cloud.worker_policy['bindings'][0]['members']
        self.assertIn('serviceAccount:' + m.LEGACY, members)
        self.assertIn('serviceAccount:' + RUNTIME, members)
        self.assertEqual(len(members), 3)
        for command in self.cloud.writes:
            self.assertFalse(any(x in ' '.join(command) for x in ('roles/editor', 'roles/run.admin', 'TokenCreator', 'remove-iam', '--set-env', '--clear-env')))
            if command[:3] == ['run', 'services', 'update']:
                self.assertEqual(command, ['run', 'services', 'update', m.WEB,
                    '--region=' + m.REGION, '--image=' + j['baseline']['imageDigest'],
                    '--service-account=' + RUNTIME])
            if '--member=serviceAccount:' + RUNTIME in command:
                self.assertTrue(any('--role=' + role in command for role in (
                    'roles/secretmanager.secretAccessor', 'roles/storage.objectAdmin', 'roles/run.invoker')))
        self.assertEqual(sum('--role=roles/secretmanager.secretAccessor' in c for c in self.cloud.writes), 4)
        self.assertFalse(any('--role=roles/storage.objectViewer' in c for c in self.cloud.writes))
        web_index = next(i for i, c in enumerate(self.cloud.writes) if c[:3] == ['run', 'services', 'update'])
        worker_index = next(i for i, c in enumerate(self.cloud.writes) if c[:4] == ['run', 'services', 'add-iam-policy-binding', m.WORKER])
        self.assertLess(worker_index, web_index)
        self.assertNotIn('NONSECRET_ENV_MUST_NOT_BE_STORED', json.dumps(self.saved))

    def test_idempotent_and_partial_failure_recovery(self):
        j = self.journal()
        self.cloud.fail = lambda args: args[:4] == ['builds', 'triggers', 'update', 'github']
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save)
        self.assertEqual(j['phase'], 'switch-trigger:pending')
        self.assertEqual(m.account(self.cloud.web), RUNTIME)
        self.assertEqual(m.trigger_account(self.cloud.trigger), m.LEGACY)
        self.cloud.fail = None
        self.tool.execute(j, self.save)
        self.cloud.writes.clear()
        self.tool.execute(j, self.save)
        self.assertFalse(any('create' in c or 'update' in c for c in self.cloud.writes))

    def test_drift_and_conflicts_fail_closed(self):
        for mutate in (
            lambda: self.cloud.web['spec']['template']['spec']['containers'][0]['env'].append({'name': 'new', 'value': 'drift'}),
            lambda: self.cloud.web['spec']['traffic'][0].update(percent=50),
            lambda: self.cloud.web['spec']['template']['spec']['containers'][0].update(image='changed'),
            lambda: self.cloud.trigger['substitutions'].update(_SAFE='changed'),
            lambda: self.cloud.worker_policy['bindings'][0]['members'].pop(),
        ):
            self.setUp(); j = self.journal(); mutate()
            with self.assertRaises(m.Unsafe):
                self.tool.execute(j, self.save)
            self.assertEqual(self.cloud.writes, [])
        self.setUp()
        self.cloud.accounts[RUNTIME] = {'email': RUNTIME}
        with self.assertRaises(m.Unsafe):
            self.cli()
        with self.assertRaises(m.Unsafe):
            m.Migration(self.cloud, RUNTIME, RUNTIME, 'projects/' + m.NUMBER)

    def test_incomplete_and_overprivileged_analysis(self):
        self.cloud.incomplete = True
        with self.assertRaises(m.Unsafe):
            self.tool.audit(True)
        self.cloud.incomplete = False
        self.cloud.extra_analysis = [{'attachedResourceFullName': '//cloudresourcemanager.googleapis.com/projects/' + m.PROJECT,
                                     'iamBinding': {'role': 'roles/editor', 'members': ['serviceAccount:' + RUNTIME]}}]
        with self.assertRaises(m.Unsafe):
            self.tool.audit(True)

    def test_rollback_identity_only_and_drift_restriction(self):
        j = self.apply()
        self.cloud.writes.clear()
        self.tool.execute(j, self.save, rollback=True)
        self.assertEqual(j['phase'], 'rolled-back')
        self.assertEqual(m.account(self.cloud.web), m.LEGACY)
        self.assertEqual(m.trigger_account(self.cloud.trigger), m.LEGACY)
        self.assertEqual(len(self.cloud.writes), 2)
        self.assertIn('serviceAccount:' + RUNTIME, self.cloud.worker_policy['bindings'][0]['members'])
        self.cloud.trigger['github']['push']['branch'] = '^other$'
        self.cloud.writes.clear()
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save, rollback=True)
        self.assertEqual(self.cloud.writes, [])

    def test_secret_refs_private_worker_and_logging_fail_closed(self):
        self.cloud.web['spec']['template']['spec']['containers'][0]['env'][-1]['valueFrom']['secretKeyRef']['key'] = 'latest'
        with self.assertRaises(m.Unsafe):
            self.tool.snapshot()
        self.setUp(); self.cloud.trigger['build']['options'] = {}
        with self.assertRaises(m.Unsafe):
            self.tool.snapshot()
        self.setUp(); self.cloud.worker_policy['bindings'][0]['members'].append('allUsers')
        with self.assertRaises(m.Unsafe):
            self.tool.snapshot()

    def test_cli_apply_journal_and_no_sdk_required(self):
        exists, output = self.cli('--apply', '--acknowledge', m.ACK)
        self.assertTrue(exists)
        self.assertIn('"phase": "verified"', output)
        self.assertNotIn('NONSECRET_ENV_MUST_NOT_BE_STORED', output)

    def test_partial_grant_failure_recovery(self):
        j = self.journal()
        self.cloud.fail = lambda args: args[:4] == ['run', 'services', 'add-iam-policy-binding', m.WORKER]
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save)
        self.assertEqual(j['phase'], 'grant:5:pending')
        self.assertEqual(m.account(self.cloud.web), m.LEGACY)
        self.assertEqual(m.trigger_account(self.cloud.trigger), m.LEGACY)
        self.cloud.fail = None
        self.tool.execute(j, self.save)
        self.assertEqual(j['phase'], 'verified')

    def test_rollback_apply_also_requires_acknowledgement(self):
        with self.assertRaises(m.Unsafe):
            self.cli('--rollback', '--apply')
        self.assertEqual(self.cloud.calls, [])

    def test_optional_source_reader_is_bucket_scoped(self):
        extra = [binding for binding in m.grants(RUNTIME, BUILD, True)
                 if binding not in m.grants(RUNTIME, BUILD)]
        self.assertEqual(len(extra), 1)
        args, resource, role, member = extra[0]
        self.assertEqual(args, ['storage', 'buckets', 'add-iam-policy-binding',
                                'gs://example-project-1_cloudbuild'])
        self.assertEqual(resource, '//storage.googleapis.com/example-project-1_cloudbuild')
        self.assertEqual((role, member), ('roles/storage.objectViewer', BUILD))

    def test_independent_binding_contract(self):
        bindings = m.grants(RUNTIME, BUILD)
        runtime_roles = {(role, resource) for _, resource, role, member in bindings if member == RUNTIME}
        expected = {('roles/secretmanager.secretAccessor',
                     '//secretmanager.googleapis.com/projects/100000000001/secrets/' + name)
                    for name in ('deepseek-api-key', 'gemini-api-key', 'steam-web-api-key', 'opendota-api-key')}
        expected |= {('roles/storage.objectAdmin', '//storage.googleapis.com/example-project-1-replay-facts-t348u'),
                     ('roles/run.invoker', '//run.googleapis.com/projects/example-project-1/locations/asia-east1/services/dota2-ai-replay-worker')}
        self.assertEqual(runtime_roles, expected)
        build_roles = {(role, resource) for _, resource, role, member in bindings if member == BUILD}
        self.assertEqual(build_roles, {
            ('roles/run.developer', '//run.googleapis.com/projects/example-project-1/locations/asia-east1/services/dota2-ai'),
            ('roles/iam.serviceAccountUser', '//iam.googleapis.com/projects/example-project-1/serviceAccounts/' + RUNTIME),
            ('roles/artifactregistry.writer', '//artifactregistry.googleapis.com/projects/example-project-1/locations/asia-east1/repositories/cloud-run-source-deploy'),
            ('roles/logging.logWriter', '//cloudresourcemanager.googleapis.com/projects/example-project-1')})

    def test_new_targets_must_be_owned_even_on_recovery(self):
        j = self.journal()
        self.cloud.accounts[RUNTIME] = {'email': RUNTIME, 'description': 'another migration'}
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save)
        self.assertFalse(any('update' in c or 'add-iam-policy-binding' in c for c in self.cloud.writes))

    def test_rollback_needs_original_journal(self):
        with self.assertRaises(m.Unsafe):
            self.cli('--rollback')
        self.assertEqual(self.cloud.writes, [])

    def test_wrong_repository_split_traffic_and_build_secrets(self):
        mutations = [
            lambda: self.cloud.web['spec']['template']['spec']['containers'][0].update(image='other-repository:mutable'),
            lambda: self.cloud.web['spec'].update(traffic=[{'revisionName': 'old', 'percent': 100}]),
            lambda: self.cloud.trigger['build'].update(secrets=[{'kmsKeyName': 'fixture'}]),
        ]
        for mutate in mutations:
            self.setUp(); mutate()
            with self.assertRaises(m.Unsafe):
                self.tool.snapshot()
            self.assertEqual(self.cloud.writes, [])

    def actual_shape(self):
        # Synthetic live-schema placeholders; no production snapshot or personal principals.
        web = self.cloud.web
        template = web['spec']['template']
        template['metadata'] = {'annotations': {
            'run.googleapis.com/client-name': 'gcloud',
            'run.googleapis.com/client-version': '594.0.0',
            'run.googleapis.com/cpu-throttling': 'true'},
            'labels': {'client.knative.dev/nonce': 'old', 'commit-sha': 'fixture-commit'}}
        template['spec'].update(containerConcurrency=80, timeoutSeconds=900)
        container = template['spec']['containers'][0]
        container.update(image='asia-east1-docker.pkg.dev/project/repo/web:fixture-commit',
                         name='fixture-container', ports=[{'containerPort': 8080, 'name': 'http1'}],
                         resources={'limits': {'cpu': '1000m', 'memory': '512Mi'}},
                         startupProbe={'failureThreshold': 1, 'periodSeconds': 240,
                                       'tcpSocket': {'port': 8080}, 'timeoutSeconds': 240})
        container['env'] += [{'name': name, 'value': 'fixture-value'} for name in (
            'UI_V2', 'FF_UI_V2', 'REPLAY_INGEST_ENABLED', 'REPLAY_AUTO_ENABLED',
            'REPLAY_GCS_BUCKET', 'REPLAY_WORKER_URL', 'REPLAY_BUDGET_DAILY_JOBS',
            'REPLAY_BUDGET_HOURLY_JOBS', 'REPLAY_BUDGET_IP_TEN_MINUTES',
            'REPLAY_BUDGET_ATTEMPTS', 'REPLAY_BUDGET_BYTES', 'REPLAY_BUDGET_WORKER_SECONDS',
            'REPLAY_WORKER_DISPATCH_TIMEOUT_MS')]
        trigger = self.cloud.trigger
        trigger['substitutions']['_SERVICE_NAME'] = m.WEB
        trigger['build']['substitutions'] = {'_SERVICE_NAME': 'overridden'}
        trigger['build']['steps'][2]['args'][3] = '$_SERVICE_NAME'

    def test_live_shape_plan_and_same_serving_bytes_apply(self):
        self.actual_shape()
        exists, output = self.cli()
        self.assertFalse(exists)
        self.assertEqual(self.cloud.writes, [])
        self.assertIn('sameBytesImage', output)
        self.assertIn('--image=' + self.cloud.revision['status']['imageDigest'], output)
        env = copy.deepcopy(self.cloud.web['spec']['template']['spec']['containers'][0]['env'])
        j = self.apply()
        current = self.tool.snapshot()
        self.assertEqual(j['baseline']['imageDigest'], current['imageDigest'])
        self.assertEqual(env, self.cloud.web['spec']['template']['spec']['containers'][0]['env'])
        self.assertEqual(current['templateImage'], current['imageDigest'])
        self.tool.execute(j, self.save, rollback=True)
        self.assertEqual(self.tool.snapshot()['imageDigest'], j['baseline']['imageDigest'])

    def test_only_known_generated_metadata_can_drift(self):
        self.actual_shape(); j = self.journal()
        metadata = self.cloud.web['spec']['template']['metadata']
        metadata['labels']['client.knative.dev/nonce'] = 'new'
        metadata['annotations']['run.googleapis.com/client-version'] = 'new'
        self.tool.validate(j['baseline'], self.tool.snapshot())
        for mapping, key in ((metadata['labels'], 'commit-sha'),
                             (metadata['annotations'], 'run.googleapis.com/cpu-throttling')):
            original = mapping[key]; mapping[key] = 'changed'
            with self.assertRaises(m.Unsafe):
                self.tool.validate(j['baseline'], self.tool.snapshot())
            mapping[key] = original

    def test_tag_digest_and_traffic_guards(self):
        self.actual_shape(); j = self.journal()
        self.cloud.web['spec']['template']['spec']['containers'][0]['image'] = 'asia-east1-docker.pkg.dev/project/repo/web:different'
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save)
        self.assertEqual(self.cloud.writes, [])
        self.actual_shape()
        self.cloud.revision['status']['imageDigest'] = 'asia-east1-docker.pkg.dev/project/repo/web@sha256:' + 'b' * 64
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save)
        self.assertEqual(self.cloud.writes, [])
        self.cloud.web['status']['traffic'][0]['percent'] = 50
        with self.assertRaises(m.Unsafe):
            self.tool.snapshot()

    def test_not_ready_partial_web_switch_rollback(self):
        self.actual_shape(); j = self.journal()
        def fail_after_update(args):
            if args[:3] == ['run', 'services', 'update']:
                self.cloud.web['spec']['template']['spec']['serviceAccountName'] = RUNTIME
                self.cloud.web['spec']['template']['spec']['containers'][0]['image'] = j['baseline']['imageDigest']
                self.cloud.web['status']['conditions'][0]['status'] = 'False'
                self.cloud.web['status']['latestCreatedRevisionName'] = 'failed-attempt'
                return True
            return False
        self.cloud.fail = fail_after_update
        with self.assertRaises(m.Unsafe):
            self.tool.execute(j, self.save)
        self.assertEqual(j['phase'], 'switch-web:pending')
        self.cloud.fail = None
        with self.assertRaises(m.Unsafe):
            self.tool.snapshot()
        self.tool.execute(j, self.save, rollback=True)
        self.assertEqual(j['phase'], 'rolled-back')
        self.assertEqual(m.account(self.cloud.web), m.LEGACY)
        self.assertEqual(self.tool.snapshot()['imageDigest'], j['baseline']['imageDigest'])

    def test_recovery_still_refuses_drift_without_writes(self):
        mutations = (
            lambda: self.cloud.revision['status'].update(imageDigest='asia-east1-docker.pkg.dev/project/repo/web@sha256:' + 'b' * 64),
            lambda: self.cloud.revision['status']['conditions'][0].update(status='False'),
            lambda: self.cloud.web['status']['traffic'][0].update(percent=50),
            lambda: self.cloud.web['spec']['template']['spec']['containers'][0]['env'][0].update(value='drift'),
            lambda: next(e['valueFrom']['secretKeyRef'] for e in self.cloud.web['spec']['template']['spec']['containers'][0]['env'] if e.get('valueFrom', {}).get('secretKeyRef', {}).get('name') == 'opendota-api-key').update(key='latest'),
        )
        for mutate in mutations:
            self.setUp(); self.actual_shape(); j = self.journal()
            self.cloud.web['status']['conditions'][0]['status'] = 'False'
            self.cloud.web['status']['latestCreatedRevisionName'] = 'failed-attempt'
            mutate()
            with self.assertRaises(m.Unsafe):
                self.tool.execute(j, self.save, rollback=True)
            self.assertEqual(self.cloud.writes, [])

    def test_trigger_substitution_must_resolve_exact_target(self):
        for token in ('$_SERVICE_NAME', '${_SERVICE_NAME}'):
            self.setUp(); self.actual_shape()
            self.cloud.trigger['build']['steps'][2]['args'][3] = token
            self.tool.snapshot()
            self.cloud.trigger['substitutions']['_SERVICE_NAME'] = 'other-service'
            with self.assertRaises(m.Unsafe):
                self.tool.snapshot()
            self.assertEqual(self.cloud.writes, [])

    def test_cli_contracts_inventory_and_analyzer(self):
        self.tool.inventory(); self.tool.audit(False); self.tool.snapshot()
        self.assertFalse(any(c[:3] == ['builds', 'locations', 'list'] for c in self.cloud.calls))
        analyzer = [c for c in self.cloud.calls if c[:2] == ['asset', 'analyze-iam-policy']]
        self.assertTrue(analyzer)
        self.assertTrue(all('--project=' + m.NUMBER in c for c in analyzer))
        self.assertFalse(any(a.startswith('--scope=') for c in analyzer for a in c))
        self.assertIn(['run', 'revisions', 'describe', 'fixture-ready', '--region=' + m.REGION], self.cloud.calls)

    def test_fake_executable_and_error_redaction(self):
        with tempfile.TemporaryDirectory() as tmp:
            executable = Path(tmp) / 'gcloud'
            executable.write_text('#!/bin/sh\necho "SECRET-RESPONSE" >&2\nexit 1\n')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': tmp}):
                with self.assertRaises(m.Unsafe) as error:
                    m.Gcloud()(['projects', 'describe', m.PROJECT])
            self.assertNotIn('SECRET-RESPONSE', str(error.exception))


class ConfigureTests(unittest.TestCase):
    """Production identifiers come from flags, validated, never from the source."""

    def tearDown(self):
        m.configure(TEST_PROJECT, TEST_NUMBER, TEST_TRIGGER)

    def test_rejects_malformed_identifiers(self):
        for bad in [('Bad_Project', TEST_NUMBER, TEST_TRIGGER), (TEST_PROJECT, '12ab', TEST_TRIGGER),
                    (TEST_PROJECT, TEST_NUMBER, 'not-a-uuid'), ('', TEST_NUMBER, TEST_TRIGGER)]:
            with self.assertRaises(m.Unsafe):
                m.configure(*bad)

    def test_derives_legacy_account_and_buckets(self):
        m.configure('other-project-2', '200000000002', TEST_TRIGGER)
        self.assertEqual(m.LEGACY, '200000000002-compute@developer.gserviceaccount.com')
        self.assertEqual(m.BUCKET, 'other-project-2-replay-facts-t348u')
        self.assertEqual(m.SOURCE, 'other-project-2_cloudbuild')

    def test_main_requires_the_identifier_flags_before_any_gcloud_call(self):
        calls = []
        argv = ['migrate', '--runtime', 'a@x', '--build', 'b@x', '--audit-scope', 'projects/1', '--journal', '/tmp/none.json']
        with patch.object(sys, 'argv', argv), patch.object(m, 'Gcloud', side_effect=lambda: calls.append(1)), \
                patch('sys.stderr', new_callable=io.StringIO):
            with self.assertRaises(SystemExit):
                m.main()
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
