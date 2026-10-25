import { useQuery } from '@tanstack/react-query'
import { BoxIcon, CheckIcon, LayoutGridIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ScrollArea,
} from 'ui'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { AppLayoutDropdownTriggerButton, AppLayoutDropdownWithPopover } from './AppLayoutDropdown'
import {
  getNewProjectUrl,
  getOpenProjectUrl,
  type SelfHostedPlatformContext,
} from './SelfHostedProjectSwitcher.utils'
import { selfHostedPlatformProjectsQueryOptions } from '@/data/self-hosted-platform/platform-projects-query'

interface SelfHostedProjectSwitcherProps {
  projectName: string
  platform: SelfHostedPlatformContext
}

/**
 * Project switcher for Studios provisioned by the self-hosted project platform.
 * Each project runs its own Studio, so switching opens the other project's Studio
 * through the platform dashboard, which signs the user in to it.
 */
export function SelfHostedProjectSwitcher({
  projectName,
  platform,
}: SelfHostedProjectSwitcherProps) {
  const [open, setOpen] = useState(false)
  const {
    data: projects,
    isPending,
    isError,
  } = useQuery({
    ...selfHostedPlatformProjectsQueryOptions({ dashboardUrl: platform.dashboardUrl }),
    enabled: open,
  })
  const hasManyProjects = (projects?.length ?? 0) > 7

  const handleNavigate = (href: string) => {
    setOpen(false)
    window.location.assign(href)
  }

  return (
    <AppLayoutDropdownWithPopover
      open={open}
      onOpenChange={setOpen}
      linkHref="/project/default"
      linkContent={
        <>
          <BoxIcon size={14} strokeWidth={1.5} className="text-foreground-lighter" />
          <span title={projectName} className="text-foreground max-w-32 lg:max-w-64 truncate">
            {projectName}
          </span>
        </>
      }
      triggerButton={
        <AppLayoutDropdownTriggerButton className="shrink-0" aria-label="Switch project" />
      }
      commandContent={
        <Command>
          <CommandInput placeholder="Find project..." />
          <CommandList>
            {isPending && <ShimmeringLoader className="m-2" />}
            {isError && (
              <p className="px-3 py-2 text-xs text-foreground-light">
                Couldn’t load projects. Sign in to the dashboard and try again.
              </p>
            )}
            {projects && (
              <>
                <CommandEmpty>No projects found</CommandEmpty>
                <CommandGroup>
                  <ScrollArea className={hasManyProjects ? 'md:h-[210px]' : ''}>
                    {projects.map((project) => (
                      <CommandItem
                        key={project.id}
                        value={`${project.name.replaceAll('"', '')} - ${project.id}`}
                        className="cursor-pointer w-full flex items-center justify-between text-sm md:text-xs"
                        onSelect={() =>
                          project.id === platform.projectId
                            ? setOpen(false)
                            : handleNavigate(getOpenProjectUrl(platform.dashboardUrl, project.id))
                        }
                      >
                        <span className="truncate">{project.name}</span>
                        {project.id === platform.projectId && <CheckIcon size={16} />}
                      </CommandItem>
                    ))}
                  </ScrollArea>
                </CommandGroup>
              </>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                className="cursor-pointer w-full gap-2"
                onSelect={() => handleNavigate(platform.dashboardUrl)}
              >
                <LayoutGridIcon size={14} strokeWidth={1.5} />
                <p>All projects</p>
              </CommandItem>
              <CommandItem
                className="cursor-pointer w-full gap-2"
                onSelect={() => handleNavigate(getNewProjectUrl(platform.dashboardUrl))}
              >
                <PlusIcon size={14} strokeWidth={1.5} />
                <p>New project</p>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      }
    />
  )
}
