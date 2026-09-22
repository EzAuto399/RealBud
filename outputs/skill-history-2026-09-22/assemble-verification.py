from pathlib import Path
from datetime import datetime,timezone
import json
p=Path('/Users/yoda/projects/RealBud/outputs/skill-history-2026-09-22')
def read(name):return json.loads((p/name).read_text())
def suite(name):
 j=read(name)
 return {'passed':j['numPassedTests'],'failed':j['numFailedTests'],'skipped':j['numPendingTests'],'files':len(j['testResults']),'success':j['success'],'receipt':name}
source=read('source-before-package.json');source_after=read('source-after-package.json');artifact=read('package-before-tests.json');artifact_after=read('package-after-tests.json')
assert source==source_after and artifact==artifact_after
full=suite('full-suite.json');assert full['success'] and not full['failed']
native=suite('native-hermes-tests.json');assert native['success'] and native['passed']==42 and not native['failed'] and not native['skipped']
full_raw=read('full-suite.json');native_raw=read('native-hermes-tests.json')
def case_map(report):
 result={}
 for r in report['testResults']:
  seen={}
  for a in r['assertionResults']:
   name=a['fullName'];ordinal=seen.get(name,0);seen[name]=ordinal+1
   result[(r['name'],name,ordinal)]=a['status']
 return result
cases=case_map(full_raw)
assert len(cases)==full_raw['numTotalTests']
resolved=0
for key,status in case_map(native_raw).items():
 assert key in cases and cases[key] in ['pending','skipped'] and status=='passed';cases[key]='passed';resolved+=1
assert resolved==42
combined={'uniquePassed':sum(v=='passed' for v in cases.values()),'failed':sum(v=='failed' for v in cases.values()),'remainingEnvironmentSkipped':sum(v in ['pending','skipped'] for v in cases.values()),'total':len(cases),'method':'Union of the full default suite and 42 separately enabled native Hermes cases, keyed by file, full test name and occurrence; no duplicate test instances added'}
profile=read('profile-packaged.json');assert profile['passed'] and profile['cleanupComplete']
assert 'OK: renderer, capabilities, embedded harness, and shutdown' in (p/'mac-smoke.log').read_text()
value={'checkedAt':datetime.now(timezone.utc).isoformat(),'scope':'Reviewed instruction history archival, bounded history/revert UI and encrypted backup/restore on macOS; reusable RealBud goal remains active','source':{'sha256':source['digest'],'files':len(source['files']),'unchangedThroughChecks':True},'artifact':{'path':str(p/'package/mac-arm64/RealBud.app'),'sha256':artifact['digest'],'entries':len(artifact['files']),'unsigned':True,'installedAppReplaced':False,'unchangedThroughChecks':True},'checks':{'fullSuite':full,'nativeHermes':native,'combinedUniqueTests':combined,'domain':read('domain-verification.json'),'independent':suite('independent-review-final-suite.json'),'backupOwned':suite('backup-owned-final-tests.json'),'uiSource':read('gui-source/receipt.json'),'uiPackaged':read('gui-packaged/receipt.json'),'previousCustomerPackGui':read('customer-pack-regression.json'),'nativeMacSmoke':{'passed':True,'receipt':'mac-smoke.log'},'freshPrivateProfile':profile,'compiledComparison':read('build-comparison.json'),'packagePreparation':{'passed':True,'receipt':'package-prepare.log'},'packageBuild':{'passed':True,'receipt':'package-build.log'}},'grok':{'requestedModel':'grok-4.7','requestedEffort':'xhigh','result':'review-deadline-timeout; no final answer or terminal actual-model usage bucket','reviewDeadlineSeconds':290,'cleanupSeconds':293.195,'promptCount':1,'retryCount':0,'cleanup':read('grok-skill-implementation-cleanup.json')},'reviewFindingsResolved':['Historical active digest commitments now constrain later hot and archived revision identities within each lineage','Live downgrade admission now requires root v2 even when the only skill head is inside an archived configuration','Actual private writer re-admits only the validated compact intent above the normal journal limit','Pending instruction updates validate revision continuation and complete plan set before effects'],'preservedEarlierEvidence':['Two fixture-only source GUI failures are retained; final source and packaged runs have zero browser errors and denied external requests','Early package typing failure fixed before final package preparation','Two full-suite attempts deliberately stopped before final source freeze; they do not count as completed test runs','Superseded package manifests and rehearsal receipts retained under pre-final-admission and pre-downgrade-fix names'],'remaining':['Repair authoritative missing two-device checker contracts and test wiring','Remote approver enrollment and shared-department execution','Native installed Windows GUI/key custody/Hermes-memory/update/uninstall and two physical office devices','Hosted connector commissioning/revocation and deployed end-to-end operation','Real Gmail/LLM consent, paired bank CSV/REI recognition and customer workday acceptance']}
(p/'verification.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'fullSuite':full,'combined':combined,'source':source['digest'],'artifact':artifact['digest']}))
