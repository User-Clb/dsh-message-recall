/**
 * 只读审计：报告每个会话里撤回标记的实际遮蔽跨度。
 */
const base = process.argv[2];

const response = await fetch(`${base}/audit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(25000),
});
const data = await response.json();

if (!data?.ok) {
  console.log('audit 失败:', JSON.stringify(data).slice(0, 200));
  process.exit(1);
}

for (const session of data.sessions ?? []) {
  console.log(`会话 ${session.sessionId}`);
  console.log(`  事件总数=${session.eventCount} 撤回标记=${session.markerCount}`);
  for (const marker of session.markers ?? []) {
    console.log(
      `  marker.seq=${marker.markerSeq}  start=${marker.startSeq}  end=${marker.endSeq}  跨度=${marker.span}  遮蔽源=${marker.sources}`,
    );
  }
}
