const text = "点击撤回这条消息和撤回当前+后面的怎么界面还显示的原文没变化";
const res = await fetch("http://127.0.0.1:58627/dsh-message-recall/recall", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text, scope: "only" }),
});
const body = await res.json();
console.log("status =", res.status);
console.log(JSON.stringify(body, null, 2));
