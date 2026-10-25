export const selfHostedPlatformKeys = {
  projects: (dashboardUrl: string | undefined) =>
    ['self-hosted-platform', dashboardUrl, 'projects'] as const,
}
