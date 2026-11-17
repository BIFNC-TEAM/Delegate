import { NextResponse } from "next/server";
import { generateServiceContentSuggestion, serviceContentInputSchema } from "@delegate/model-runtime";
import { dashboardAuthErrorResponse, requireDashboardApiOwnerSession } from "../auth";
import { withPrivateNoStore } from "../../private-response";

const reply = (body: unknown, status = 200) => withPrivateNoStore(NextResponse.json(body, { status }));
export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    if (!session?.ownerId?.trim()) return reply({ error: "Authentication required." }, 401);
    const input = serviceContentInputSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) return reply({ error: "Invalid request." }, 400);
    const result = await generateServiceContentSuggestion(input.data);
    const { attempts: _attempts, ...body } = result;
    return reply(body, result.status === "timeout" ? 504 : result.status === "model_failure" ? 502 : result.status === "invalid_input" ? 400 : 200);
  } catch (error) {
    return dashboardAuthErrorResponse(error) ?? reply({ error: "Unable to process service content request." }, 500);
  }
}
