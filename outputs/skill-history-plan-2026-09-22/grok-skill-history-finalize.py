"""Finalize an existing bounded Grok review; no model call or source edits."""
from pathlib import Path
import datetime, hashlib, json, subprocess
out=Path(__file__).resolve().parent
run=json.loads((out/'grok-skill-history-acp-run.json').read_text())
assert 'exitCode' in run and run.get('processReaped')
rows=subprocess.check_output(['ps','-axo','pid=,ppid=,pgid='],text=True)
own=[list(map(int,line.split())) for line in rows.splitlines() if len(line.split())==3 and int(line.split()[2])==run['ownedPid']]
config=hashlib.sha256(Path('/Users/yoda/.grok/config.toml').read_bytes()).hexdigest()
cleanup={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ownedPid':run['ownedPid'],'remainingOwnedProcessRows':own,'processReaped':run['processReaped'],'isolatedHomeRemoved':run['isolatedHomeRemoved'],'globalConfigSha256':config,'globalConfigUnchanged':config==run['globalConfigSha256Before'],'credentialsRead':False,'credentialsCopied':False,'modelRetries':0}
(out/'grok-skill-history-cleanup.json').write_text(json.dumps(cleanup,indent=2)+'\n')
meta=run.get('terminal',{}).get('_meta',{});usage=meta.get('usage',{})
corrections=[
'Advice case 1 is a proposed ABA stress test, not an observed defect. The proposed archive preview already binds generation, active revision/digest, exact hot list and head. Revert needs equivalent durable binding. No extra epoch should be added unless those identities cannot uniquely bind the operation.',
'Advice case 2 says a retry must not block backup. That is only correct after archival completion: an unresolved durable intent intentionally blocks backup. Before the journal commit, old referenced history plus exact pending intent must remain recoverable; automatic rollback of every journal byte is not the design.',
'Advice case 3 assumes archival clears approvals; this is incorrect. Metadata-only archival preserves all approval/schedule/active-instruction values. A reviewed revert, separately, clears approvals and pauses schedules.',
'Advice case 3 says every root is acyclic while their union cycles. With complete traversal and canonical immutable node identity, that cannot happen: a reachable cycle belongs to a root traversal. Implement path-local cycle detection plus global validated-node memoization; the real risk is confusing repeated valid references with cycles or skipping validation after incorrect identity deduplication.',
'The review gives test suggestions only. No source implementation, test execution, release approval, provider call or customer acceptance was performed by Grok.'
]
d={'completed':run.get('completed'),'requestedModel':run['requestedModel'],'selectedModel':run.get('returnedModelOption'),'effort':run.get('returnedReasoningEffort'),'actualModels':list(usage.get('modelUsage',{})),'modelCalls':usage.get('modelCalls'),'numTurns':usage.get('numTurns'),'terminalStopReason':run.get('terminal',{}).get('stopReason'),'terminalUsage':usage,'terminalTopLevelTotalTokens':meta.get('totalTokens'),'usageAccountingNote':'Retained as returned: terminal top-level total differs from usage/model-bucket total; do not silently reconcile.','terminalSeconds':run.get('terminalAtSeconds'),'elapsedIncludingCleanupSeconds':run.get('elapsedSeconds'),'promptBytes':run['promptBytes'],'promptRequests':run['promptRequestsSent'],'toolCalls':run['toolCallCount'],'permissionRequests':run['permissionRequestCount'],'mcp':run.get('observedMcpInitialization'),'mcpServers':run.get('observedMcpServerCount'),'advisoryCorrections':corrections,'proofScope':'Sanitized source/design packet; advice only, no production source access or test evidence.'}
(out/'grok-skill-history-disposition.json').write_text(json.dumps(d,indent=2)+'\n')
lines=['# Grok reviewed instruction history advice','','One 1,952-byte sanitized source/design packet. No tools, web, MCP, customer data or secret contents were supplied. This is advice, not implementation or test evidence.','',f"Actual model bucket: {', '.join(d['actualModels'])}; effort {d['effort']}; {d['modelCalls']} call, {d['numTurns']} turn; {d['terminalStopReason']}; {d['elapsedIncludingCleanupSeconds']} seconds including cleanup.",f"Usage bucket: input {usage.get('inputTokens')}, output {usage.get('outputTokens')}, reasoning {usage.get('reasoningTokens')}, total {usage.get('totalTokens')}. Top-level terminal total separately returned {meta.get('totalTokens')}.",'']
for case in (run.get('structuredOutput') or {}).get('cases',[]):
 lines += ['## '+case['title'],'',case['setup'],'']+['- '+a for a in case['assertions']]+['']
lines += ['## Source-review adjudication','']+['- '+a for a in corrections]+['','Owned process group independently checked empty; temporary private home removed; global configuration SHA-256 unchanged. Authentication used an opaque symlink; the harness did not read/copy authentication contents. No retries. These are process/configuration checks, not an OS sandbox claim.','']
(out/'grok-skill-history-review.md').write_text('\n'.join(lines))
print(json.dumps({'cleanup':cleanup,'disposition':d},indent=2))
