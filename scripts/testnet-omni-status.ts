/** Read the LayerZero Scan state that matters when an ONFT packet appears stuck. */
import { ProxyAgent, fetch } from "undici";

async function main() {
  const tx = process.env.OMNI_TX;
  if (!tx) throw new Error("OMNI_TX is required");
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const response = await fetch(`https://scan-testnet.layerzero-api.com/v1/messages/tx/${tx}`, {
    dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
  });
  if (!response.ok) throw new Error(`LayerZero Scan HTTP ${response.status}`);
  const body: any = await response.json();
  const message = body.data?.[0] ?? body.messages?.[0] ?? body[0];
  if (!message) throw new Error("LayerZero Scan returned no message");
  const verification = message.verification ?? message.pathway?.verification;
  console.log(JSON.stringify({
    sourceTx: tx,
    guid: message.guid,
    status: message.status,
    stage: message.stage,
    source: message.source,
    destination: message.destination,
    verification,
    config: message.config,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
