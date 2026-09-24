export function resolveChildTools(parentTools: string[], agentTools: string[] | undefined): string[] {
	const parentAllowlist = new Set(parentTools.filter((name) => name !== "subagent"));
	if (agentTools === undefined) return [...parentAllowlist];
	return agentTools.filter((name, index) => parentAllowlist.has(name) && agentTools.indexOf(name) === index);
}

export function appendToolArgs(args: string[], tools: string[]): void {
	if (tools.length === 0) args.push("--no-tools");
	else args.push("--tools", tools.join(","));
}
