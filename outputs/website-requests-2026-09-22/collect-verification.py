from pathlib import Path
from datetime import datetime, timezone
import hashlib, json
b=Path(__file__).resolve().parent
root=b.parent.parent
read=lambda name:json.loads((b/name).read_text())
source=read('source-final-freeze.json'); after=read('source-after-tests.json')
package=read('package-before-tests.json'); packaged_after=read('package-after-tests.json')
full=read('full-final-tests.json'); focused=read('focused-final-tests.json')
assert source['files']==after['files'] and package['files']==packaged_after['files']
assert full['numFailedTests']==0 and focused['numFailedTests']==0
comparison=read('built-file-comparison.json'); assert all(v['checked'] and not v['mismatches'] for v in comparison.values())
source_gui=read('gui-source/receipt.json'); package_gui=read('gui-packaged/receipt.json')
for v in [source_gui,package_gui]:
    assert len(v['checks'])==5 and not v['errors'] and not v['denied'] and not v['site']['violations'] and not v['site']['databaseErrors']
managed_source=read('managed-mail-source/integration-receipt.json'); managed_package=read('managed-mail-packaged/integration-receipt.json')
assert managed_source['passed'] and managed_source['cleaned'] and managed_package['passed'] and managed_package['cleaned']
profile=read('profile-packaged.json'); assert profile['passed'] and profile['cleanupComplete']
assert '[smoke-mac-package] OK:' in (b/'mac-smoke.log').read_text()
website=read('website-verification.json'); connector=read('managed-account-precondition-verification.json')
assert website['ok'] and connector['ok'] and read('grok-observation-account-green.json')['providerScanCalls']==0
reviews=[]
for prefix in ['grok-website','grok-observation']:
    review=read(prefix+'-disposition.json'); cleanup=read(prefix+'-cleanup.json')
    assert review['completed'] and review['stopReason']=='end_turn' and cleanup['processReaped'] and cleanup['isolatedHomeRemoved']
    reviews.append({'receipt':prefix+'-disposition.json','actualModel':review['actualModelBuckets'],'effort':review['selectedEffort'],'modelCalls':review['modelCalls'],'turns':review['numTurns'],'stopReason':review['stopReason'],'seconds':review['terminalAtSeconds'],'cleanup':prefix+'-cleanup.json'})
result={
    'at':datetime.now(timezone.utc).isoformat(),'passed':True,
    'source':{'head':'5856140c6ba49f53e79a7edbf01800e099b53e10','files':len(source['files']),'digest':source['digest'],'unchanged':True,'scope':'Desktop source and build inputs plus the changed managed-gateway connector implementation/tests; website has its own source manifest.'},
    'fullSuite':{'passed':full['numPassedTests'],'failed':full['numFailedTests'],'skipped':full['numPendingTests'],'files':len(full['testResults']),'reportedSeconds':round((max(v['endTime'] for v in full['testResults'])-full['startTime'])/1000,3),'receipt':'full-final-tests.json'},
    'focusedSuite':{'passed':focused['numPassedTests'],'failed':focused['numFailedTests'],'overlapsFullSuite':True},
    'website':website,'managedAccountPrecondition':connector,
    'artifact':{'path':str(b/'package/mac-arm64/RealBud.app'),'entries':len(package['files']),'digest':package['digest'],'unchanged':True,'signed':False,'installedReplacement':False,'electron':'43.4.0','node':'24.18.1'},
    'sourceGui':source_gui,'packagedGui':package_gui,'managedSource':managed_source,'managedPackaged':managed_package,
    'profile':profile,'nativeMacSmoke':{'passed':True,'receipt':'mac-smoke.log'},'buildComparison':comparison,
    'grokReviews':reviews,'independentAccountRebind':read('grok-observation-account-green.json'),
    'cleanup':{'websiteQaProcessesExitZero':True,'managedQaReceiptsCleaned':True,'profileReceiptCleaned':True,'grokHomesRemoved':True},
    'limits':['No deployed portal migration or service update','Fictional mail/provider and deterministic CLI responses; no real Gmail/LLM/customer acceptance','Unsigned fresh artifact; installed app not replaced','No native Windows or physical two-device proof','Remote approver enrollment and shared-department adapters remain pending','Reviewed skill-instruction archival remains next local work','Full-site lint retains two documented pre-existing failures'],
}
(b/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'passed':True,'fullSuite':result['fullSuite'],'source':source['digest'],'artifact':package['digest']}))
