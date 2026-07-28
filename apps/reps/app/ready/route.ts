import {
  preflightWeChatPayRuntime,
  prisma,
} from "@delegate/web-data";

export async function GET() {
  const [databaseReady, weChatPay] = await Promise.all([
    checkDatabaseReadiness(),
    Promise.resolve(preflightWeChatPayRuntime()),
  ]);
  const ready = databaseReady && weChatPay.ready;
  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      service: "reps",
      databaseReady,
      weChatPay,
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

async function checkDatabaseReadiness(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
