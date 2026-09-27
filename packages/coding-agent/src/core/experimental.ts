export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.NEK_EXPERIMENTAL === "1";
}
