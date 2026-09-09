# MemeLoop implementation checkpoint

This file is the durable resume point for the multi-repository implementation.
It exists so context compaction does not turn completed work back into pending
work. Update it when a gate changes state; do not reconstruct progress from chat
history alone.

## Resume rules

1. Treat phases and green gates below as monotonic. Re-run a green gate only
   when files in its dependency scope changed after the recorded evidence.
2. Before acting after a resume, compare the repository HEAD, dirty paths, and
   the relevant gate. Do not repeat branch inventories, PR-comment inventories,
   or broad review scans without a new upstream change.
3. A failed or rate-limited sub-agent does not erase its filesystem edits. Inspect
   the delta first; do not automatically re-delegate the same task.
4. Use the isolated Cloud worktree. Never reconcile against the concurrently
   edited original Cloud checkout by overwriting either tree.
5. Advance from the first incomplete item in "Current delta". Historical notes
   are evidence, not a new task list.
6. Do not start another broad audit or add another audit agent. The repository
   scanners now define the universal review rules. Consolidate the existing
   deltas, make each repository green once, commit, and move forward.
7. The orchestration-incident audit is closed. Do not read the thread again to
   reconfirm it, do not restate its statistics, and do not treat a context
   compaction as permission to replay any completed review or gate.

## Authoritative next action — 2026-09-09 trial delivery and concrete runtime blockers ONLY

Read this snapshot first; the following continuation entries are historical evidence.

**Resume directly here:** npm publication, all three downstream registry updates,
all current CI/platform builds, PR descriptions and worklog24.93 are DONE.
Do not repeat source audits, publications or green builds. New targeted fixes/gates
are permitted only for the concrete real-machine blockers recorded below.
TidGi Windows download and local verification are DONE. Original download exec96638
has no live resume process. windows_trial_preflight is STOPPED; no further work there.
Existing parallel/artifact-complete.zip is649287140bytes, GitHub SHA256 verified:
40a721a28308096cf74cf142c658cabffdf88b110e3c7e85461160a48574c8b1.
unzip -t passed. Reuse parallel/extracted/squirrel.windows/x64/Install-TidGi-Windows-x64.exe;
installer SHA256 d170f87ec7dd6423d26c123abb7441eb3ec2f9b41d7f11875f2ae8c5d8d4c52e
matches included manifest. Intended app.asar verified directly from nupkg:
3a3f960349d39994b0dd98f2b686a2718f91f692ebeeca63923b964725e1e041.
Bounded Luna worker sansheng_verified_installer now owns sansheng transfer/install/startup
verification only (same_version_install_check interrupted after no status response;
no SSH/scp process survived). It must first check already transferred files/processes, preserve
all user data, and use visible desktop only. No new downloads/builds. Compare installed
app.asar, not only About version. Real install/startup is still pending.
WINDOWS TRANSFER DONE by bounded Luna: C:\Users\Remote\Downloads\Install-TidGi-run34308518285-x64.exe,
remote SHA256 matchesd170f87ec7dd6423d26c123abb7441eb3ec2f9b41d7f11875f2ae8c5d8d4c52e.
No TidGi process; administrator and remote desktop sessions are both disconnected.
User reports RDP login and installation completed; application running and MCP
enabled at38385. sansheng_verified_installer now owns read-only actual app.asar,
Squirrel/startup logs and MCP tool-list/wiki-state verification. Do not reinstall
or stop the running application. Actual installation hash is now verified below.
WINDOWS INSTALLED HASH NOW PROVEN: app.asar matches3a3f960...; actual tidgi.exe at
C:\Users\Remote\AppData\Local\tidgi\app-0.14.3-prerelease2. Squirrel17:37:14–17:38:07
completed without error. MCP POST /mcp on38385 initialize2025-06-18 and tools/list
PASS (ui_window/snapshot/screenshot/click/type/key/navigate/evaluate).
TRIAL BLOCKERS FOUND (do not mark goal complete): startup log
%APPDATA%\TidGi\logs\2026-09-09\global\main.1.log SQLite NOT NULL
temporary_agent_definitions.systemPrompt => Agent runtime unavailable; defaultwiki
create failed becauseC:\Users\Remote\Desktop\wiki exists; no active workspace/view,
5212 not listening. No cache deletion/wiki overwrite authorized or performed.
desktop_trial_cache_diagnosis stopped after no result; root narrowly confirmed
hostAgentDefinitionEntity requires systemPrompt and clearAgentDatabase calls
database.deleteDatabase('meme-loop') then restart. Delete removes onlydb/-wal/-shm.
User NOW EXPLICITLY AUTHORIZED "直接清空，不用备份" for AgentDB. Windows worker may
clear that database (no backup), restart normally and verify runtime; never clear
wiki/globalprovider settings/wholeuserData. Existingwiki has validtiddlywiki.info,
tiddlers/.git/tidgi.config; oldsettings lacking canonicalfields were sanitized out.
Windows worker owns publicUI import-existing-wiki+activate (no wiki overwrite)
and authorizedAgent reset/restart. App installer remains paused during this step.
CONCRETE SAFETY FIX: root found both Desktop and App getDatabase catch blindly
copy/unlink/copy viafixDatabaseLock even forschemaerrors. Bounded workers
database_failure_preservation (Desktop) and app_database_failure_preservation (App)
own removing that destructivefallback and adding focusedfailurepreservation tests;
no migration/auto-reset/manifest changes, no commit/push until root checks results.
Only these changed-source gates may rerun; no whole-repo audit/republication.
SAFETY FIX PUSHED: Desktop890d9395 (database service/interface/failure test only),
10 database tests PASS, TypeScript/lint PASS, pre-push contracts/full lint PASS.
Current new-source CI watcher53271 active: Release34344868743, CodeQL34344868328.
Appb0010ad1 pushed same boundedfix, 2 tests/typecheck/filelint PASS. Current source
diff removes destructivefixDatabaseLock, no schema/default/data migration changes.
New CI applies only to these actual changed heads; earlier green gates are history.
No Core/libp2p/CLI/UI package change or manual npm publication required.
App watcher71158 TERMINAL1: newheadb0010ad1 runs34345082330/34345082353 never
started. APIannotation check102444662356 explicitly cites accountpayments/spending
limit; user asked asynchronously to fixBilling/Actions. Do not rerun until resolved.
Desktopwatch53271 remainslive; unit5m2s andCodeQL3m15s pass, calibration/build pending.
APP WINDOWS DOWNLOAD/LOCAL VALIDATION DONE: artifact10090754968 assembled at
/home/chenshuangfeng/Github/memeloop-release-artifacts/ci-34317610266-app-win-x64/assembled.Upvwh9.zip,
454206393bytes, official SHA256b3d44767d0df015ecfe12d105ed9cdc71c62141d018b882d7603fc20a7da834c
matches; unzip-t PASS. Final validation exec2973 TERMINAL0, all lanes terminal0.
All four bundled SHA256SUMS entries PASS after mapping build prefixout/make/ to
the artifact root (Windows binary-mode asterisk retained; original manifest unchanged).
Verified installer at verified/squirrel.windows/x64/Install-MemeLoop-Desktop-Windows-x64.exe,
SHA25645baf6165d0d32ed52400e75d99381d65d2b7ab3828bd0c4a017c6a95f0ed163,
148388352bytes. Expected installedapp.asar from nupkg:
13ce2e01896140b31946a40b94fbf6973b2126ce8fe3a11cc9af25a22c50cc1f.
Bounded Luna sansheng_app_file_delivery COMPLETE: sansheng Downloads
Install-MemeLoop-Desktop-run34317610266-x64.exe exists148388352bytes, remote
Get-FileHash matches45baf616...; no GUI action occurred. TidGi/MCP owner stays
sansheng_verified_installer, informed it may use an exposed running-instance
openPath capability to visibly launch this installer if supported, never session0.
No further App download or script execution is needed.

The following App download recovery details are historical, NOT active sessions:
Root took App10090754968 download: app_registry_delivery was interrupted
after its download stopped and it failed to return status. Do not resume that
worker or its old download.sh (64MiB/retry-overwrite policy). Original four
range-N.bin prefixes are preserved and validated against their exact206 ranges.
New root-owned resume-app-ranges.sh in ci-34317610266-app-win-x64 initially ran in exec99894:
4 concurrent monotonic lanes, 1MiB requests, retry0, validated partial retention,
exclusive flock, no full-range restarts; bash syntax/fourprefix/wrongrange checks pass.
Proxy switch: old exec99894/PG2320383 stopped with143, all valid bytes retained.
Current root App download exec8590 uses socks5h://127.0.0.1:19081 over Mac SSH
forward exec13363. Probe passed206/1MiB in3.08s. Logs proxy-resume.log.
Original proxy8590 now TERMINAL exit1: its unpatched lanes stopped onTLS EOF.
All progress retained. Current per-lane recovery handles: lane0=3227,
lane1=12679, lane2=81928; lane3=30217 TERMINAL exit0 COMPLETE through454206393.
Old lane0=49612/lane1=18474/lane2=98205 are terminal failures and must not be polled.
Each log proxy-laneN-recovery.log; new requests use8MiB via proxy, reusing existing
1MiB/partial segments by their validated actual header range (never skip them).
Do not launch another whole downloader while these run. Once all terminal, rerun
main script to reuse completed manifests and assemble/verify. New script bounds
no-byte retries at5, never overwrites attempted segments.
New lane starts hold exclusive per-lane flock as well; no duplicate recovery jobs.
Expected App artifact454206393bytes, SHA256
b3d44767d0df015ecfe12d105ed9cdc71c62141d018b882d7603fc20a7da834c.
After full digest/ZIP validation transfer ownership to Windows worker; it must
not independently download the App artifact. TidGi downloader remains untouched.
User now explicitly reports Mac restored. Existing mac_trial_delivery worker is
resumed for SSH, final artifacts, installation and real-session startup evidence.
Its preceding failed probe made no remote changes; do not infer current failure
from that historical result. Preserve data and do not stop running user apps.
FRP now CONNECTED; LAN still timeout. No TidGi/MemeLoop processes observed.
Remote old packaged-apps-mac-x64.zip is NOT target digest; preserved, not installed.
Correct TidGi ZIP on Mac at
/Users/linonetwo/Downloads/tidgi-run34308518285-artifact10088448235.zip.
Mac worker preserved6127616-byte prefix and stopped originalPID2320, then started
three nonoverlapping tails under Downloads/.tidgi-parts-10088448235.
Latest resumed tail PIDs8852/8853/8854; olderPIDs3692/3693/3694 are historical.
Old400 probe was expired URL, NOT unsupported Range; fresh206 probe passed.
Worker owns bounded resume/parallelization, final digest/ZIP checks and installation;
remote gh invalid is not a blocker (local authorization supplies short-lived URL).
App Mac x64 also downloading PID9726, independent file
/Users/linonetwo/Downloads/memeloop-app-run34317610266-artifact10090778355.zip,
official size130117355bytes SHA25652cadec8a6d389b7626b369963ef21e190dbd58b7faf5b28af00a9501338a71b.
Initial206 range0-130117354 verified, no old matching prefix existed.
User reports Mac/Win local1080 SOCKS5 proxies can greatly accelerate downloads.
Windows tunnel31652/SSH2436989 closed after repeatedTLS EOF; Mac tunnel13363 worked
and was closed (SSH2483165 terminated) after App local verification completed.
No system proxy configuration changed.
MAC APP INSTALLED: officialZIP52cadec8... verified, outer/innerunzip tests pass,
innerSHA256SUMS targetc95117e3ee73b102fa0b4d0a4daca2b17ec587969aacf9120fa31234e62ea427.
Installed separately /Applications/MemeLoop Desktop 0.14.1.app (old app preserved),
main/GPU/network helpers running, no oldrpc.proto error found. Chat use not yet proven.
MAC TIDGI RECOVERY: prior worker wrongly combined-C and fixedRange, causing oversized
appends. PID11725/11726/11727 stopped, all files preserved. Bounded Luna
mac_tidgi_range_recovery owns the bounded candidate recovery described below;
do not concatenate or install unverified parts. mac_trial_delivery is done, no further
TidGi operations assigned to it. Use proven range coverage, never assume oversized=valid.
Mac range recovery READ-ONLY result: part0 actual139299829bytes, part1=130334720,
part2=101203039. Common suffix from local6127616 matches acrossparts; successful
probe[10485760,11534336) anchors local=global, but broad mapping remainsinferred.
Originalprefix[0,6127616) proven. No livecurl. Existingwrongcandidate digest534a8bc3...
fails ZIP test, do not use. Chosen next attempt: newcandidate prefix0..6127616 +
part0 suffix6127616..139299829, fetch ONLY tail[139299829,210705778) via8MiB proxy
ranges with validated partial retention, NO-C/no-overwrite. FinalofficialSHA/ZIP
must pass before trust/install. Worker preparing localscript viaapply_patch and
must send root path then PAUSE for script review before running newdownload.
Worker never returned script; stopped. ROOT now owns exactsamecandidate recovery.
Local scripts release-artifacts/mac-tidgi-tail-chunk.sh and mac-tidgi-tail-driver.sh
syntaxchecked; remote helper Downloads/mac-tidgi-tail-chunk-20260909.sh.
Driverexec78285 TERMINAL0, exact206 partialproof storedlocally mac-tidgi-tail-proof/manifest.tsv,
remote immutabletailfiles .tidgi-recovery-10088448235. Onlymissingtail139299829..210705778,
8MiB requests retry0 max60s proxy1080, <=5 emptyfailures. No-C/nooverwrites.
Do not restart/redelegate while driverlive; finalcandidate officialSHA still required.
MAC TIDGI RECOVERY DONE: assembleexec41066 TERMINAL0; candidate
/Users/linonetwo/Downloads/tidgi-recovered-10088448235.8oYvs6 is210705778bytes,
officialSHA35589c642666e6a638172fe0d232c3b3a8068ee9e05f1f9effb24620d708acf4
matches andunzip-t PASS. Originalfiles preserved; no more download/recovery needed.
Bounded Luna mac_verified_tidgi_install now owns innerchecksum/extraction/install/
visibleGUI startup evidence. Preserve oldapp/data, do not clearMac AgentDB (user
reset authorization was specificallysansheng). Older recovery steps are history.
Sansheng desktop is now opened by user; no new build is needed.
Current App final head534b94a0 and run34317610266 are GREEN; final Mac x64
artifact10090778355, ARM64 artifact10090666479. Older run IDs below are history.
All entries below preserve historical details and must NOT reopen completed work.

Worklog24.93/record commit96100a9 PUSHED (documentation only). Its CI34318963314
PASSED8m6s, watcher60420 TERMINAL exit0. No Core/downstream CI watcher remains
needed. Prior source and artifact gates remain valid; only download/remote trial
delivery remains. Do not push another docs-only checkpoint just to record green.

LATEST DELIVERY: Desktop868e26b1 ALL CI GREEN: Release34308518285 (unit,
two calibration jobs, six E2E shards, six platform builds) and CodeQL34308518125.
Old watcher21430 handle missing; replacement15408 returned terminal0/full green.
No Desktop watcher remains live; do not restart or re-run these gates.
Windows artifact10088497890 packaged-apps-win-x64; Macx64 artifact10088448235.
Windows worker owns download/hash verification/transfer to sansheng; no hidden
GUI launch, current install/startup still pending. Mobile91fa887 all FIVE CI
checks GREEN, watcher1164048 TERMINAL; no further Mobile build/test work needed.
App worker owns current trial run34310665730 at35d6cc3b (HTTPS git dependency
rewrite fixed initial trial build). Follow that run, no duplicate builds/audits.
App winx64 artifact10088365208 and macarm64 artifact10088271701 SUCCESS,
unsigned/checksums included; macx64 job102336489682 queued for runner capacity.
Windows worker also owns App installer transfer after TidGi, distinct filenames.
mac_trial_delivery worker owns TidGi macx64 download/hash/SSH transfer to Mac
Downloads only; no replacing/launching apps. App macx64 delivery awaits build.
Desktop PR body updated all-green; root updating Mobile previously stale PR body
to exact current versions/213tests/fivegreen checks and honest48lintwarnings.
Both PR body updates completed. Root now owns App run34310665730 watcher36225
(live,60second interval), macx64 still queued. App source worker done; do not
redelegate waiting under a new name or rebuild successful platforms.
CORRECTION: root inspected new trial-build.yml and found x64 uses retired
macos-13, not a proven capacity queue. Official runner-images issue13046 confirms
retirement. Same App worker now fixes runner to Desktop-proven macos-15-intel,
adds bounded runner contract, and excludes SHA256SUMS.txt from checksum input
(current redirection can include itself). Follow next exact run after fix;
existing Windows/ARM64 executable bytes remain usable, do not discard artifacts.
App fix534b94a0 now committed; source worker owns push/new run. Root stopped
obsolete watcher36225 (exit130) only, NOT the GitHub workflow or stored artifacts.
Mac preflight terminal: FRP115.190.161.250:21626 connection refused, LAN
192.168.1.126 timeout. No remote changes. Mac artifact download was stopped by
worker, incomplete files at stale-cwd release-artifacts/tidgi-artifact-10088448235;
not verified/delivered. User asked asynchronously to restore SSH and unlock
sansheng desktop. Windows worker continues transfer task; do not duplicate it.
App534b94a0 PUSHED: CI34317610259 and Trial34317610266 BOTH PASSED.
Artifacts Windows10090754968, MacARM6410090666479, Macx6410090778355 (unsigned,
checksums). App source worker COMPLETE, no live watcher or new build needed.
Windows transfer worker notified: preserve already-running/completed older App
download (same application source; only workflow/checksum changes) rather than
restart. All three downstream CI gates green; remaining transfer/install/startup.
Windows TidGi download LIVE session21085 (worker-owned), 8 authenticated ranges,
165646336/649287140 bytes at last report, path release-artifacts/
ci-34308518285-packaged-apps-win-x64/parallel/. No transfer yet. Same worker
resuming to checksum+transfer, then App latest10090754968. Do not duplicate.
Download follow-up: root interrupted only the worker's prolonged waiting turn,
confirmed curls1596822/1596823 remained alive. Direct sansheng1MiB range test
returned206 at45950B/s, slower; no GUI or remote file created. Existing local
download preserved541953938/649287140 bytes (83.5%). Same worker resumed original
transfer, no more speed experiments/restarts. Wait bounded chunks; only final
checksum+delivery evidence changes the remaining action.
Tail recovery: original full8-range processes terminal; part4/7 incomplete.
Live corrected tail curls1879120/1887351 use tail-4-correct.bin and
tail-7-correct.bin, headers206/ranges352829440-405804464 (52975025bytes) and
616988672-649287139 (32298468bytes). Old tail-4.bin requested wrong absolute start
28185868; it is preserved but NOT usable as the intended tail. Original artifact.zip
564013647bytes is incomplete and NOT verified. Do not count duplicate files with du.
same_version_install_check explorer owns read-only Squirrel same-version install
question (sansheng old build already0.14.3-prerelease2), no remote operations.
Worker reports tail curl auto-retries TRUNCATE output files: not monotonic progress.
Same worker now replacing only faulty tails with bounded small segments, retry0,
headers/range validation and resume by retained byte offset. Preserve complete
parts and correct prefixes. TailPID1879120/session46737 and1887351 are superseded
only after ownership-checked stop. Never label download complete until exact649287140
bytes and GitHub artifact ZIP digest match. No user application changes yet.
Current downloader is resume-ranges.sh (root reviewed/fixed exact206/range checks,
partial prefix resumption and mktemp non-overwrite; bash-n +4validator cases pass).
Worker owns LIVE exec96638; monotonic part4 cursor388362188 reported, then part7
still required. Stop treating old tailcurl sessions as live. Throughput slow but
positive; no new download/test/PR inventory needed. Continue96638 until terminal.

Publication follow-up: UI0.2.2 NOW AVAILABLE; registry SHA512 matches the exact
566b55f archive (session73437 exit0). Core and UI publication checks are COMPLETE.
Mobile/App registry workers resumed their same bounded tasks; root owns Desktop
delivery. Desktop registry commit868e26b1 PUSHED to PR743; frozen install and
pre-push repository contracts/TypeScript/zero-warning lint PASSED. PR body updated
with current 75scenario/1930step local evidence and pending current installer gate.
Desktop gh pr checks --watch session38646 RUNNING: Release34308518285 and
CodeQL34308518125. CodeQL PASSED; Release confirmed running unit tests.
Desktop unit PASSED6m23s and Linux calibration PASSED11m29s; Windows calibration
PASSED19m24s; six Linux/Windows E2E shards now running on same Release run.
Watcher38646 TERMINAL exit1 due API TLS
handshake timeout (not CI failure). API curl recoveredHTTP200; replacement
watcher21430 follows same PR/run, no CI restart. Resume21430 only.
Resume handle, do not start another watcher or local full suite.
Mobile/App workers still own their locks/checks/push/CI. Desktop untracked chunk
file is preserved and not committed. Next is CI completion and current artifacts.
Mobile policy repair91fa887 PUSHED after0cb3d0e; frozen/check/lint passed (48
pre-existing formatting warnings, no errors). Clean tree. Worker owns live
watcher PID1164048, final-head five checks running. Do not duplicate watcher.
App final heada10c4392 PUSHED (registry1f171437, policy196046cc+a10c4392).
Root/nested frozen installs pass; clean tree, PR description updated. Same worker
confirmed final-heada10c4392 CI34308704037 PASSED5m58s. No artifacts retained:
workflow only smoke-packages Linux. Same App worker now owns narrowly adding
downloadable trial artifact delivery/reusing existing platform build route.
Do not repeat source audits or claim current App installer exists yet.
App artifact commit32190324 CI34309213024 PASSED5m7s; Linux artifact10087793626
exists. Worker is clarifying artifact suffix041ce3f3 versus PRhead (merge SHA).
Same worker owns next Windows/macOS Forge artifact build matrix (no existing
platform workflow), scoped to trial delivery, no source cleanup/new npm release.
App Windows/macOS trial workflow commits e1b9be4e+9adc428f added; worker reviewing
only that workflow and recovering run ID after transient API TLS errors. Outputs
unsigned, no npm or GitHub release publication. Linux existing artifact retained.
Windows preflight COMPLETE on sansheng only: Win11x64, Node24.18.0, C61.8GiB/
E795GiB free. No TidGi process. Installed0.14.3-prerelease2 is historical.
SSH runs session0; Explorer session3 currently disconnected. Current artifact
should go to C:\Users\Remote\Downloads\Install-TidGi-Windows-x64.exe and have
SHA256 verified. User-visible installation/cold start requires active unlocked
session3; no hidden PowerShell, scheduled-task or session0 app launch. No install
has occurred. Worker is complete; do not repeat preflight after compaction.
Do not ask user to publish again or reverify these unchanged archives.

Historical publication observation at 2026-09-09 03:40UTC: user reported publication complete.
Core0.3.1 registry SHA512 matches the exact ec94e85 archive. UI0.2.2 still returns
E404; direct no-cache official registry metadata lists latest0.2.1 and no0.2.2.
Do not repeat installs while it is absent. Desktop and Mobile manifests are now
prepared with registry ^0.3.1/^0.2.2, but locks still have local candidates; no
dependency commit/push yet. App registry worker is COMPLETE: both mobile and
nested desktop manifests use ^0.3.1/^0.2.2, existing archive locks untouched;
diff-check passed, no install/commit/push. All preparation workers are terminal.
Desktop has unrelated untracked chunk-H4HAKJAU-BDIM8ptG.js; preserve it.
Next: obtain UI0.2.2 publication/availability, check its integrity, regenerate
locks and frozen installs, commit/push downstreams and watch CI. Do not rerun
the completed source/unit/E2E gates or verify Core archive again.

- Canonical Core worktree: `/home/chenshuangfeng/Github/memeloop-core-review-20260831`.
  Never edit/build the stale `/home/chenshuangfeng/Github/memeloop` worktree.
- Published UI0.2.1 is already integrated downstream. Do not reverify/reinstall it.
- Desktop uses verified UI0.2.2 archive `react-ui-0.2.2-settings-20260908-566b55f/`
  and verified Core0.3.1 archive `core-0.3.1-ec94e85/` in release-artifacts.
  Install6743 completed. Both adjacent VERIFICATION.md records are current.
  Do not commit local manifest/lock paths or reuse superseded Core candidates.
- Core ec94e85 CI34246664077 PASSED9m26s; watch43899 is TERMINAL.
  UI0.2.2 aggregate235/235 passed61047. Do not repeat these completed gates.
- Desktop cloneable ForRenderer transport FIXED: package16592 succeeded
  14:45:37UTC; configError33035 PASSED2scenarios/34steps21.876s, including actual
  settings navigation through contextBridge. Temporary trace removed.
  Fix committed268fa580; that worker is complete.
- Wiki native registration FIXED89195eb7+7e710d6f; current package32198 succeeded
  September8 16:07:03UTC. Single Wiki59186 PASSED23steps4.851s: wire includes
  all3Wiki tools with optional defaults; real Index tool output reaches next model
  request (fixture assertion7ca552ca). Temporary mock schema tracing removed.
  TypeScript91849 and native helper2tests/lint31749 passed. All workers complete.
- Desktop full unit44807 TERMINAL PASSED. validate:push77046 check/types passed,
  lint found only4format warnings in3disabled-tool files. Autoformat applied;
  full lint68257 TERMINAL PASSED zero warnings; formatting commite9f514bf.
  Full Desktop E2E93189 TERMINAL PASSED75scenarios/1930steps15m9.390s.
  Do not package/restart it. Temporary test-only logs already removed.
  Do not run Desktop unit and E2E simultaneously (shared test fixtures).
- Mobile and App candidate preflights are COMPLETE; their workers are done.
  Both use exact verified ec94e85/566b55f archives. No source audit or local-path
  commits/pushes. Replace only their recorded candidate manifests/locks later.
- Mobile candidate type/lint and correct isolated runtime invocation pass. Earlier
  CONTEXT_COMPACTION_FAILED was worker command duplication: forwarded relative
  runtime path plus wrapper's mandatory absolute path ran same suite twice in one
  process. NOT product defect; no source changes. Worker's canonical result was
  lost; root's one evidence-recovery repeat is now TERMINAL SUCCESS15071:
  34 suites/212 tests plus isolated runtime1suite/1test, exit0. Session recovered
  from the last tool response after compaction; no new test was started.
  Mobile changes manifests only. Do not rerun this completed gate.
- App candidate preflight COMPLETE: mobile type/lint/7tests, desktop frozen
  install/check/lint passed. Only local tar paths in apps/mobile/package.json,
  root pnpm-lock.yaml, apps/desktop/package.json, apps/desktop/pnpm-lock.yaml.
  Do not repeat App preflight or commit local references.
- All local publication gates are GREEN. Request manual publication of exact
  core-0.3.1-ec94e85/memeloop-0.3.1.tgz followed by
  react-ui-0.2.2-settings-20260908-566b55f/memeloop-react-ui-0.2.2.tgz.
  Both live under /home/chenshuangfeng/Github/memeloop-release-artifacts.
  Do not republish CLI/libp2p or UI0.2.1. Do not rebuild these verified archives.
  After user confirmation: verify registry integrity once, replace local paths
  with registry versions in Desktop/Mobile/App, commit/push, watch canonical CI,
  and deliver current trial artifacts. These steps remain PENDING.
  Do not reopen prior broad audits or repeat green gates without source changes.
- Handoff follow-up: documentation commit e2fa79d PUSHED successfully. Its
  GitHub run34253400613 PASSED in9m44s; watcher19427 is TERMINAL exit0.
  Do not resume/restart it. Source-gate evidence at
  ec94e85 remains valid (only documentation changed). Both requested npm versions
  returned E404 at 2026-09-08 16:49UTC; user publication is still required.
  Do not repack or repeat local gates while waiting for manual publication.
- Core ec94e85 PUSHED via SSH443 in terminal-success1572. HTTPS1881/2415
  failed; use SSH443 for future pushes if HTTPS still blocked. No user auth needed.

## Historical continuation — 2026-09-08

Latest gate update: Desktop prompt-audit failure is fixed by acquiring the
independent `promptPreview` BrowserWindow. The exact named scenario passed all
20 steps in 12.285 seconds. Core follow-up `14089e3` is pushed; candidate tarball
is `memeloop-release-artifacts/react-ui-0.2.1-timeline-fix-20260908-14089e3/`
`memeloop-react-ui-0.2.1.tgz`, SHA-256
`10f437d6af094edd403c25cc7870819644a5e6dbb3d00546923539cd6cd69887`.
Installation into Desktop and validate:push both passed. Fresh packaging with
the follow-up succeeded at 08:43:51 UTC. Both calibration runs passed 14
scenarios / 408 steps each; the measured-timeout long-conversation scenario
then passed 20 steps in 12.282s. Desktop full unit command passed. Core CI run
34205833720 passed in 9m29s. Those process handles are now terminal; do not
restart them. Candidate clean install/export verification passed and is
recorded beside the tarball in VERIFICATION.md. This archive is ready for
manual npm publication. Desktop infrastructure/E2E changes are committed as
c6c797c1; preference assertions and a ComfyUI fail-closed regression are
committed as b1056c0a. The added regression passed its direct Vitest and ESLint
commands. ComfyUI workflows remain intentionally unsupported without a provider
plugin; the removed legacy workflow-path E2E did not describe a current runtime
capability. Registry manifests remain temporarily local and uncommitted.

Publication completed September 8: registry SHA-512 exactly matches the verified
archive. Desktop now uses registry ^0.2.1, frozen install and pre-push checks
passed, and commit a7dda759 was pushed to PR #743. PR description is updated to
current versions/evidence. CI watch is live in session 91505: Release App run
34208711998 and CodeQL run 34208711791. Resume that handle, not a new test run.
Core documentation head a42cfec CI run34207467870 also passed.

Two bounded downstream dependency tasks are active: `app_ui_patch_release` and
`mobile_ui_patch_release`. They own only registry dependency/lock updates to
React UI0.2.1, proportionate install/type checks and canonical pushes/CI watch.
Do not duplicate them or reopen prior broad reviews. All source gates above are
complete; do not rerun merely because of a context resume.

Downstream update: App pushed eecc5385, frozen install/type checks passed for
both nested desktop and root/mobile. Canonical PR is open at
https://github.com/memeloop-online/memeloop-app/pull/2 (old namespace redirects).
Its validate CI passed in 6m03s; no duplicate PR was created. Mobile pushed
a8118f3 to PR #109; frozen install, TypeScript and pre-push check/lint passed;
five CI jobs pending. Existing Mobile watch PID1571754 remains owned by
mobile_ui_patch_release, which was asked to follow it through completion.
Mobile PR109 now passed all five CI checks; watch exited. Desktop run34208711998
is terminal: CodeQL, unit and BOTH calibrations passed; all six E2E shards
failed and build skipped. Do not resume terminal watcher91505.

### Exact Desktop CI repair batch (after a7dda759)

Latest result: full local E2E70187 is TERMINAL:67/75 scenarios and1850/1929
steps passed (8 failures,71 skipped),16m00s. Do not resume or repeat full run yet.
All newAgent edit/create, subwiki5, simplifiedWiki, streaming, wiki plugin and
attachment baseline scenarios passed. Remaining8: agent wiki-search/wikioperation,
ask-question, configError settings action, disable-tool prompt exclusion, vector3.
User's current goal is release these fixes for renewed trial/review.

Current bounded follow-ups:

- mobile_ui_patch_release owns native tool-call alignment: real built-in Core
  profile incorrectly instructed XML; mock responses also emitted XML while
  runtime only handles native tool calls. Authorized edits in canonical Core
  profile/prompts plus Desktop native mock fixtures. No legacy XML runtime.
- desktop_prompt_audit owns explicit disabled tool override precedence (Desktop
  frameworkConfig adapter, editor/runtime); ready, focused tests6+2 passed;
  also prevents preview autosave with temporarily blank name. Wait for package.
- Root owns Core AgentRunFailure.toJSON in runState.ts + regression. Actual
  electron-ipc-cat serialize-error(maxDepth:1) previously erased settingTarget;
  toJSON preserves only bounded public detail.22 error tests and actual IPC
  serializer roundtrip passed. Changed-file lint session16595 pending.
- Build ONE local Core0.3.1 candidate containing both upstream fixes after native
  tool owner ready, install Desktop, package once, run affected E2E. No manual
  publish request until verified. Existing react-ui0.2.1 release remains valid.

Candidate now built/packed: Core996f93b (d366831 error serialization,9d91e1f
native profile); tarball at
/home/chenshuangfeng/Github/memeloop-release-artifacts/core-0.3.1-integration-20260908-996f93b/memeloop-0.3.1.tgz.
SHA25658bdba540ae73ed63848fe864e0ddd3021a97d445ac8c639c8930c0c5e1947e7;
48 export targets/680 files verified, no workspace protocol, build passed.
Desktop installation91769 completed. Package produced20:52 September8; no
packager remains running. TypeScript fixes committed ddc8114e; native mocks and
all fixture conversions committed7221d4af. Disabled-tool packaged E2E passed
1scenario/30steps in6.920s. Config-error E2E29962 is terminal:1passed/1failed;
structured settings detail still lost later in the coordinator/UI path.
desktop_prompt_audit owns ONLY this follow-up. Root runs native tool E2E cluster;
do not run concurrent E2E on the shared mock port. No new package publication
request until these affected packaged gates pass.
Native cluster10017 is TERMINAL:10/15scenarios passed,346/396steps,2m16s.
Ask-question now passes. Five failures remain wiki-search/wiki-operation/vector3;
wiki-search shows INTERNAL_ERROR rather than tool result. app_ui_patch_release
owns that precise native wiki execution failure; desktop_prompt_audit continues
settings detail loss. mobile_ui_patch_release fixes two stale XML assertions
in mockOpenAI.test.ts exposed by direct Vitest63315 (4pass/2fail). No broad
audit and no full-suite repeat yet. Core candidate clean install running11655
in memeloop-release-artifacts/core031-clean-install-tHN5gC. Install11655 completed;
all48export targets and13subpaths pass ESM/CJS loading. VERIFICATION.md beside
the archive records publication remains gated by Desktop behavior.
Mock native tests now6/6pass; fix committed3cb443d9. That worker is complete.
Desktop settings serialization follow-up a92383ae committed: enumerable bounded
agentRunError survives session serialization; coordinator tests8/8pass. Package
28200 succeeded13:16:32UTC. Config-error E2E23876 running now. Wiki owner has
no source fix yet; it must use the next coordinated single-scenario slot after
23876 rather than repeating full unit shards. Earlier10017 failure artifact was
from current0.3.1candidate, not a pre-candidate run.
Config23876 TERMINAL still1pass/1fail at title/action after32.975s; enumerable
field change alone does NOT close the defect. desktop_prompt_audit must now
reproduce the full controller/renderer chain and locate the actual loss point,
not propose another serialization-only fix. Wiki owner has the next single
Wiki-search E2E slot. No full E2E or new publication request is authorized by
these partial green unit tests.
Actual configuration-action loss located: shared React UI coreTypes.ts
normalizeMemeLoopChatError unconditionally calls safeErrorFromUnknown, dropping
agentRunError before host resolveErrorPresentation. desktop_prompt_audit now
owns narrow upstream fix/regression there (authorized; no version/build yet).
Plan next React UI0.2.2 candidate only after focused regression, then package
Desktop with both local candidates. User-published0.2.1 is confirmed but does not
contain this new fix. Wiki single scenario after latest package also failed;
app_ui_patch_release is inspecting durable run error, not editing counts.
Shared UI fix committed566b55f, version0.2.2. Focused4tests pass; build/dts,
export boundaries, MUI compatibility and review-contract gate pass. Candidate
memeloop-release-artifacts/react-ui-0.2.2-settings-20260908-566b55f/
memeloop-react-ui-0.2.2.tgz packed. Desktop local installation6377 is RUNNING;
resume it, do not restart. After install, package and config-error E2E are next.
Install6377 succeeded; package36708 succeeded13:45:05UTC. Config6394 TERMINAL
still1pass/1fail32.640s, generic screenshot. UI normalization regression alone
does NOT close full path. desktop_prompt_audit now owns actual bounded renderer
instrumentation and single config E2E slot; no more speculative candidate builds.
Wiki artifact preserved outside cleanup at memeloop-release-artifacts/
desktop-wiki-search-e7143d/userData-test. Stored INTERNAL lacks diagnostic detail;
app_ui_patch_release authorized narrow Core catch diagnostic hook/regression,
without raw prompt/token/error-message logging. No version/build from worker.
Debug Desktop package94008 succeeded13:53:52UTC with temporary bounded
DesktopAgentChatTab error trace. Exact config trace artifact prefix
1h4ju-mtsqi8cu-21366 shows error entering Desktop adapter ALREADY has name
RemoteAgentExecutionError and only code/name/retryable own keys; structured
agentRunError absent. Thus earlier UI fix cannot alone solve it. Prompt worker
now follows Core execution coordinator normalization before this boundary.
App worker accidentally added diagnostic hunks in stale memeloop worktree;
instructed to transfer only its hunks to canonical review worktree and undo
only those stale additions. Do not build stale tree or overwrite its user edits.
Prompt worker confirmed actual earlier loss is Electron contextBridge cloning
Error from preload to renderer (Node serializer roundtrip is insufficient).
Authorized Desktop-only cloneable typed result envelope at agent submission/
prepare transport and renderer AgentRunFailure unwrapping. Worker owns this;
no Core coordinator patch needed. Temporary Desktop traces must be removed
after actual E2E proves fix. App diagnostic hook moved to canonical worktree,
12tests pass, but root requested multiline-secret/size bounding and logger
failure isolation before building. UI0.2.2 archive verification completed in
adjacent VERIFICATION.md; no publication approval yet.
UI aggregate gate61047 RUNNING: `pnpm --filter @memeloop/react-ui test` uses
package jsdom config. Root command20894 incorrectly used root node config and
failed document-not-defined; that is not a source regression and must not be
treated as new work. Resume61047 only; package scope config is required.
UI61047 TERMINAL PASSED:36files/235tests,12.94s. Do not rerun for a context
resume; this gate covers current0.2.2 candidate normalization source.
Core diagnostic hook committed0d663da; lifecycle13/13 and changed-file lint
pass. Core build8151 and pack61638 completed. NEW distinct candidate:
memeloop-release-artifacts/core-0.3.1-diagnostic-20260908-0d663da/memeloop-0.3.1.tgz.
Old996f93b candidate is superseded for Desktop debug, not overwritten.
Desktop installation20760 running; resume only. Transport owner implementing
clone-safe ForRenderer methods plus unwrap in coordinator/conversation client;
wait for their source readiness before package. No concurrent E2E now.
Parent removed fake UI component mock in AgentRunErrorSettingsAction test;
real registry component test passed (included in99446097).

- `desktop_prompt_audit` owns missing prompt-config-form/edit-agent-prompt-form
  in newAgent and promptEditAndToolToggle scenarios; preserve prompt/tool editor
  capability, no selector-only dismissal or test removal.
- `mobile_ui_patch_release` (Mobile task complete) now owns common send/runtime/
  mock-fixture failures: no chat messages after send, wiki plugin full/sidebar0,
  agent tool/streaming tests. Not editor or Wiki conversion lifecycle.
- `app_ui_patch_release` (App task complete) now owns real peer-process crash
  during Convert default wiki to simplified structure, observed Linux+Windows.
- Root owns remaining failure inventory and coordinated packaging; workers must
  not package concurrently. No broad audit or completed gate replay.
- Root also owns five subWiki fixture failures (shard3). Fixtures lacked canonical
  workspaceType and portable routing fields, hidden by unknown casts. wiki.ts
  setupSubWikiWithOptions now uses typed canonical fields and tidgi.config.json.
  Initial subwiki scenario advances past workspace assertions; old package then
  fails loading its root tiddler, covered by the pending folder-loader fix.
- Fixes ready: 7a469979 omits null modelConfig in instance projections; uncommitted
  definition adapter maps Core loopId and omits null modelConfig; Wiki loader
  supports root tiddlers and sets boot.wikiTiddlersPath for simplified saves.
  Their focused regressions passed; Wiki owner's full unit run and check passed.
  Parent changed-file ESLint + coordinated fresh package passed (11:09:05UTC).
  Full `pnpm run test:e2e` is now live in session70187 with existing calibration.
  Resume that handle; do not package or start another E2E over it. No extra npm
  release is needed for these host fixes. Workers have completed their edits;
  root owns verification, final logical commits and push after this run.
  Logical commits now saved locally: e7180272 (loop profile adapter), a8da65f0
  (simplified loader), 2bf056f4 (typed subwiki fixtures), plus7a469979(null model
  overrides). First portion of full E2E still reports failures; wait for its
  exact final assertions before another edit/rebuild. Do not claim this run green.
- Linux shard2 logs/artifacts downloaded to
  /home/chenshuangfeng/Github/memeloop-release-artifacts/desktop-ci-34208711998-linux-2.
  Its seven failures are the three categories above. LongConversationRenderer
  and preferences passed this shard. Full log retrieval session21734 completed;
  job logs are cached. Shard1 has7 failures (agent sends/settings action), shard3
  has11 (five subwiki fixtures, six sends/attachments/vector workflows), matching
  Linux and Windows. Linux3 artifacts also downloaded beside Linux2, suffixlinux-3.

- Continue only the Desktop packaged E2E gate. Previously green Cloud, Mobile,
  App and Core aggregate gates remain complete; no new broad review is needed.
- Core PR #2 received `a116872` via SSH push. React UI 0.2.1 is a local candidate,
  not yet approved for publication. A follow-up regression exposed a second
  recenter after host loading changes; manual browsing now survives those
  renders until selection or active-message/timeline identity changes.
  Its 42 long-conversation tests, changed-file ESLint and package build/export
  checks pass. Repack this follow-up before testing or publishing it.
- Desktop fresh packaged long-conversation run on September 8 completed 18
  steps, including timeline seeks and old-message rendering. It failed at
  `I open the generated model-request prompt audit` (300000 ms); the final
  request-content assertion was skipped. The sole delegated Desktop task is
  `desktop_prompt_audit`, investigating this exact failure.
- Desktop preference scenario already passed all 42 steps in the prior run.
  Desktop package.json/lock currently use a local React UI tarball; restore
  registry dependencies before committing those manifests.
- Next: fix the prompt-audit failure, install the follow-up UI tarball, run the
  targeted scenario, then complete calibration/CI and release evidence. Do not
  interpret the historical reconciliation tables below as new pending tasks.

## Active reconciliation batch — 2026-09-03

This is the only active batch after the incident audit. Each task has one
repository owner and one aggregate-gate objective; a resumed root agent must
wait for or reconcile these exact tasks instead of creating replacements.

| Task                  | Repository                     | Scope                                                               |
| --------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `cloud_final_gate`    | isolated Cloud review worktree | Cloud server lint, full test, build; exact red-light fixes only     |
| `core_cli_final_gate` | Core review worktree           | Core/CLI final lint, type, test, build and review-contract gates    |
| `desktop_final_gate`  | TidGi Desktop canonical branch | Desktop final type, zero-warning lint, unit and package/build gates |
| `mobile_final_gate`   | TidGi Mobile canonical branch  | Mobile final type/lint/Jest/storage and available build gates       |
| `app_final_gate`      | MemeLoop App canonical branch  | App final type/lint/test/build and existing contract scanners       |

All five tasks are forbidden from branch/PR/history inventories, broad review,
committing, pushing, or modifying another repository. Root owns evidence
recording, logical commits, pushes, PR updates and CI watching after the batch.

### Batch evidence

- `cloud_final_gate` — complete. In the isolated Cloud worktree,
  `pnpm --filter @memeloop/cloud-server lint`, the full package test suite and
  package build passed. Vitest reported 133 passed / 1 skipped files and 754
  passed / 2 skipped tests; CJS, ESM and declaration builds passed. The gate
  made no further file changes.
- Cloud's 69-path delta was then committed as nine reviewable changes on the
  isolated branch and rebased onto current `origin/feat/private-relay-server`
  without force-pushing. A recovery ref named
  `backup/cloud-review-pre-rebase-20260903` preserves the exact pre-rebase
  state. Remote payment/image changes crossed the local Nacos/schema/image
  refactors, so `cloud_post_rebase_gate` is the sole active Cloud task; its
  purpose is conflict-integration validation, not a repeat of the earlier gate.
- `desktop_final_gate` — source gate complete. `pnpm run validate:push` passed
  repository contracts, TypeScript and zero-warning ESLint; the full unit suite
  passed 21 files / 150 tests. Main, preload, renderer and plugin production
  Vite builds also passed after pinning the linked AI SDK's required
  `@ai-sdk/provider-utils` version. Electron Forge then reached native packaging
  and failed on an external toolchain download (`TypeError: fetch failed`), so
  the post-change native installer/E2E evidence must come from macOS/Windows CI;
  the source/unit gate is not to be rerun locally.
- `core_cli_final_gate` — complete. The aggregate root test and build passed:
  Core 1961/1961, libp2p 98/98 and CLI 619/619 tests (7 environment skips),
  plus all Core/CLI/package builds and the existing review/boundary/export/Zod
  contract gates. The final lint had zero errors and `git diff --check` passed.
  Do not run another Core/CLI aggregate gate unless commit preparation changes
  source behavior.
- Core's retained breaking contract changes require new release lines because
  the prior versions already exist in the public registry. Manifests are now
  `memeloop@0.3.0`, `@memeloop/libp2p@0.3.0`, `memeloop-cli@0.3.0`,
  `@memeloop/protocol@0.2.0` and `@memeloop/react-ui@0.2.0`. The post-version
  `pnpm check:packages` gate passed all five packed archives, including export,
  dependency and `workspace:` checks.
- Cloud PR #4 was pushed at `adba411`. Its server/package gate was green locally,
  but CI `build-test` exposed previously uncompiled `memeloop-admin` TypeScript
  errors against the current commerce APIs. The original Cloud post-rebase owner
  was resumed for this exact CI red light; do not start a second Cloud fix task
  or rerun the unrelated 761 cloud-server tests.
- `mobile_final_gate` — software gate complete. Check and lint passed with zero
  lint errors; Jest passed 34 suites / 212 tests plus the isolated SQLite runtime
  integration; E2E TypeScript passed; Android Expo export produced a 17.5 MiB
  HBC bundle. The gate fixed a real backward-page double reversal in long
  conversation storage and corrected Metro/runtime dependency resolution.
  Physical-device E2E remains open because this host has no `adb`; it was not
  replaced with a mock.

## Orchestration incident audit

The thread record confirms an orchestration loop after the 2026-08-31 17:08
(Asia/Shanghai) review instruction:

- The first review turn ran 15.86 hours with 12 context compactions and 247
  sub-agent events. It completed and pushed the Core review work and green Core
  CI, and produced Desktop/External commits.
- The following repository-wide review turn ran 40.76 hours with 10 context
  compactions, 53 distinct sub-agent threads, 771 sub-agent events, and no final
  response.
- After multiple compactions the same broad Core/Desktop/Cloud/App/Mobile audit
  was announced and delegated again under different task names. Green milestones
  were not frozen before more edits were admitted into the same worktrees.

This was an orchestration failure, not evidence that the earlier implementation
did not happen. The corrective rule is consolidation only: no new broad audit,
no replay after compaction, and one final aggregate gate per repository after
its existing delta stops changing.

## Reconciliation freeze — 2026-09-03

The original thread, rather than a compaction summary, is authoritative for the
state before the loop. It records that an earlier convergence stage had already
reached all of the following milestones: review threads were at zero, Desktop
and Mobile CI were green, the Cloud Harbor digest was verified, final Windows
artifacts existed, and only visible-device/external-network acceptance evidence
remained. Later compactions incorrectly reactivated older repository-wide audit
items.

All remaining sub-agents were stopped after this was confirmed. Do not execute
the old delta list below as a task queue and do not assume the large dirty trees
are all new requirements. They are now evidence to reconcile.

Current remote/local facts at the freeze:

- Core PR #2 is at `7ec20ab918cc` with green CI; the detached review worktree is
  at that exact commit with 428 dirty paths accumulated after it.
- Desktop PR #743 is at `318796b7503c`; the local branch is three commits ahead
  at `3c433a5bb30d` and also has 217 dirty paths. Its displayed green CI belongs
  to the earlier remote head, not to the dirty review delta.
- The active goal had consumed 22,235,692 tokens and 284,857 seconds. This is an
  orchestration-loop signal, not an implementation progress metric.

The only permitted next workflow is:

1. Compare each dirty delta to its canonical remote PR head and classify paths
   as already-pushed duplicate, genuinely new review fix, or unrelated/unclear.
2. Preserve all existing files while doing that classification; do not reset or
   discard any dirty worktree.
3. Move only genuinely new review fixes into a clean, current-head integration
   worktree, run one proportional aggregate gate, commit, and push.
4. Do not invent a new package release/version solely because the loop produced
   local changes. Release only if a retained source fix changes a published
   package.

## Snapshot — 2026-09-03 (Asia/Shanghai)

| Repository            | Worktree / branch                                                                    | Base HEAD      | Dirty paths |
| --------------------- | ------------------------------------------------------------------------------------ | -------------- | ----------: |
| Core monorepo         | `memeloop-core-review-20260831` / detached, push target `feat/private-relay-rpc-e2e` | `7ec20ab918cc` |         425 |
| Desktop               | `TidGi-Desktop` / `feat/memeloop-0.1-integration`                                    | `3c433a5bb30d` |         198 |
| Mobile                | `TidGi-Mobile` / `feat/memeloop-0.1-mobile`                                          | `7a8ad19e5bd7` |          83 |
| Cloud                 | `memeloop-cloud-review-20260901` / `tmp/cloud-review-snapshot-20260901`              | `4535674d6df6` |          10 |
| App                   | `memeloop-app` / `feat/memeloop-0.2-app-integration`                                 | `01303f96fae3` |         182 |
| External orchestrator | `external-orchestrator` / `main`                                                     | `b78e06985b66` |          40 |

Dirty counts are descriptive only. These are accumulated implementation changes
owned by this plan and must not be discarded.

## Completed evidence — do not repeat without relevant changes

- Core framing v2, protocol-v2-only registration, stream abort semantics,
  coordinator, sync paging/state, signed pairing invites, long-conversation
  paging contracts, and shared UI work have already been implemented and tested
  during this plan. Their final aggregate gate remains pending because later
  public-contract refactors changed Core files.
- `@memeloop/libp2p`: 19 suites / 98 tests plus browser build and bundle passed.
- `@memeloop/protocol`: 4 test files / 7 tests plus build and declarations passed.
- `@memeloop/react-ui`: 232 tests, TypeScript, build, declarations, boundary and
  review-contract checks passed. Only final zero-warning lint is still required
  after any later UI changes.
- Desktop focused provider validation/i18n tests (26), External API settings and
  failure UI tests (35), and a subsequent repository TypeScript check passed.
- Desktop's production-contract scanner is already implemented with a
  comment/string-aware lexer, TypeScript-AST empty-catch detection, all-match
  source locations, and scanner self-tests. The earlier note claiming this was
  unfinished was stale compaction state.
- Mobile review-gate self-tests passed after it was hardened to reject
  comment-only catches, unsafe casts, allow-marker bypasses, and fixed E2E sleeps.
- Cloud strict immutable Nacos bundle/pointer/digest tests passed (18/18) in the
  isolated worktree.
- External orchestrator build/lint/tests passed against the local Core candidate:
  acceptance 19/19, worker 58/58, Kubernetes 50/50, Swarm 36/36 with one intended
  Docker skip. Registry-policy verification waits for the final Core release.
- Core PR #2 had no unresolved review threads at the last PR inventory. Do not
  fetch it again until new comments or a push require it.

## Universal review rules being enforced

- Public behavior must be implemented and tested, not merely declared.
- One canonical Core type/state/security/RPC/JSON contract; no host DTO mirrors
  or conversion layers.
- No old-field migration or compatibility fallback for this pre-release reset.
- No silent catch, comment-only catch, fake success, fixed-sleep fake-green test,
  unbounded read/cache/stream, unsafe cast, or platform-specific lifecycle leak.
- User-facing failures are localized and actionable; security/configuration
  writes fail closed and surface errors.
- Large roots are decomposed behind explicit extension/plugin contracts.

## Superseded loop-era delta — historical only, do not resume here

1. **Complete — Core library / active CLI delta (2026-09-03):** current `memeloop` build passed;
   `check:review-contracts` passed across 507 production files; provider routing
   already uses bounded canonical JSON; the remaining text-protocol/schema/TUI
   findings were corrected; 19 affected Core tool tests and 6 CLI TUI tests
   passed. A downstream local-link declaration build then exposed one CLI
   `getTurnDetail` path still returning full `ChatMessage` rows. It now projects
   bounded `ConversationMessageListProjection` rows; the CLI declaration build
   and its 2 SQLite RPC adapter tests pass. This CLI production edit requires
   only the final aggregate CLI gate, not another Core library audit. The first
   Desktop integration gate then exposed one precise Core defect: native provider
   tool calls with empty assistant text were incorrectly skipped by the plugin
   response hook. The hook now consumes the canonical call list independently of
   text; its new regression plus the focused Core tool/loop gates pass (58 tests),
   and the Core build passes.
2. **Complete — Desktop production delta; final aggregate pending (2026-09-03):** removed storage-key-to-ID,
   portable-config-ID, and path-to-main-workspace fallbacks; creation/editing now
   use `mainWikiSelection` and persisted hierarchy uses only `mainWikiID`.
   The scanner prevents their return and passed across 602 production files;
   its 4 self-tests, 43 affected tests, TypeScript, and full zero-warning lint
   passed. Desktop's two old text-tag tool integration fixtures now emit native
   provider tool calls; `multiTurnToolUse` (3) and `allToolsIntegration` (9) pass
   against the rebuilt local Core. Do not run the aggregate unit/package gate
   until Desktop stops changing, and then run it once.
3. **In progress — Mobile:** non-storage chat/execution/attachment adapters now
   use current projections, execution-target values and canonical parts. Their
   4 focused suites / 26 tests pass. The remaining compile delta is isolated to the storage adapter
   migration, which has one precise owner; do not re-open the broader Mobile
   audit.
4. App: finish canonical Core prompt/provider type adoption and remove legacy
   account migration. Run canonical-contract scanners and affected tests.
5. Cloud: finish the single-current-schema reset and reconcile LLM proxy tests
   with the real streaming/backpressure/abort/billing contract. Use only the
   isolated Cloud worktree.
6. After these deltas are green, run each repository's final aggregate gates,
   prepare the 0.3 package set, update registry dependencies after the user's
   npm 2FA publication, push canonical branches, watch CI, and append auditable
   evidence to `AGENT_ORCHESTRATION_PLAN.md`.

## Known external evidence still pending

- Two independent-NAT relay/DCUtR evidence.
- Android and iOS physical-device pairing/sync evidence.
- Sleep/network-switch/relay-renewal dogfood evidence.
- Harbor image digest and final Windows installer/startup evidence.

These remain incomplete until observed; mocks do not close them.
