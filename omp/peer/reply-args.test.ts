/**
 * The argument-name contract of `peer_reply` / `peer_send`.
 *
 * `hub` names the message field `message`; the Orca CLI underneath names it
 * `body`; these two named it `text`. Measured over 7 days: 33 of 68 peer_reply
 * failures were `text ... (was missing)` with the answer sitting in `message` —
 * half this tool's failures were a name collision with its neighbour, not a
 * routing problem. `message` accepted since 2a73258.
 *
 * `body` was added 2026-08-15 because aliasing one of the three names only
 * removed one of the collisions. The remaining one is the sharpest: this tool's
 * own `execute` spawns `orca orchestration reply --body`, so the name it
 * rejected was the name it uses. It was hit by a coordinator that had run
 * `orchestration send --body` minutes earlier.
 *
 * A name contract is exactly the kind of fix that regresses in silence: someone
 * tightens the schema in six months, the 33 failures come back, and nothing
 * turns red. These tests are that alarm. They drive the real registered tools
 * through a stub `pi`, so they break if the schema stops accepting `message`,
 * if the resolution stops preferring `text`, or if a call with neither field
 * stops being refused.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import peerExtension from "./index.ts";

type Registered = {
	name: string;
	parameters: { safeParse: (v: unknown) => { success: boolean } };
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
		content: { type: string; text: string }[];
		isError?: boolean;
	}>;
};

function registeredTools(): Map<string, Registered> {
	const tools = new Map<string, Registered>();
	const pi = {
		zod: z,
		registerTool: (tool: Registered) => tools.set(tool.name, tool),
		// The extension registers hooks and commands too; a stub swallows them.
		on: () => {},
		registerCommand: () => {},
		addTool: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
	};
	peerExtension(pi as never);
	return tools;
}

const tools = registeredTools();

describe.each([
	["peer_reply", { message_id: "msg_nonexistent" }],
	["peer_send", { peer: "nobody" }],
])("%s argument names", (name, base) => {
	const tool = tools.get(name);

	test("is registered", () => {
		expect(tool).toBeDefined();
	});

	// Through `parse`, never around it. OMP validates a tool call against the zod
	// schema and hands `execute` the RESULT, and a non-strict zod object STRIPS
	// keys it does not declare rather than rejecting them. So a test that calls
	// `execute` with a raw object proves only that the destructuring reads the
	// field — it passes with the field absent from the schema, which is exactly
	// the production failure. Verified by deleting `body` from the schema: all
	// assertions still passed until this helper was routed through `parse`.
	const throughSchema = (params: Record<string, unknown>) =>
		tool?.parameters.parse(params) as Record<string, unknown>;

	test.each(["text", "message", "body"])("`%s` survives schema validation", (field) => {
		expect(throughSchema({ ...base, [field]: "hi" })[field]).toBe("hi");
	});

	test("refuses a call carrying neither, instead of sending an empty body", async () => {
		const result = await tool?.execute("call-1", throughSchema({ ...base }));
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toMatch(/text/);
	});

	test.each(["message", "body"])("a call carrying only `%s` gets past the empty check", async (field) => {
		// It then fails on routing (no such peer / no reply route), which is the
		// proof the alias resolved: the empty-body refusal never fired.
		const result = await tool?.execute("call-2", throughSchema({ ...base, [field]: "hi" }));
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).not.toMatch(/nothing to send/i);
	});
});
