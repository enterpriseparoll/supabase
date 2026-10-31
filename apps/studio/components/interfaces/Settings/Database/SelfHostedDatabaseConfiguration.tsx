import { zodResolver } from '@hookform/resolvers/zod'
import { useParams } from 'common'
import { useForm } from 'react-hook-form'
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Form,
  FormControl,
  FormField,
  Input,
  Switch,
  Textarea,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { z } from 'zod'

import {
  useSelfHostedDatabaseSettingsMutation,
  type SelfHostedDatabaseSettingsData,
} from '@/data/config/self-hosted-database-settings'

const number = (max: number) =>
  z
    .union([z.literal(''), z.coerce.number().int().min(1).max(max)])
    .refine((value) => value !== '', 'A connection limit is required')
const schema = z.object({
  poolSize: number(1000),
  maxClientConnections: number(10000),
  logConnections: z.boolean(),
  logDisconnections: z.boolean(),
  enforceSsl: z.boolean(),
  allowedCidrs: z.string().max(2600),
})
type Values = z.infer<typeof schema>
const valuesFrom = (data: SelfHostedDatabaseSettingsData): Values => ({
  poolSize: data.poolSize,
  maxClientConnections: data.maxClientConnections,
  logConnections: data.logConnections,
  logDisconnections: data.logDisconnections,
  enforceSsl: data.enforceSsl,
  allowedCidrs: data.allowedCidrs.join('\n'),
})

export const SelfHostedDatabaseConfiguration = ({
  data,
}: {
  data: SelfHostedDatabaseSettingsData
}) => {
  const { ref } = useParams()
  const update = useSelfHostedDatabaseSettingsMutation(ref)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: valuesFrom(data),
    values: valuesFrom(data),
    resetOptions: { keepDirtyValues: true },
  })
  const { isDirty } = form.formState
  const handleSubmit = (values: Values) => {
    update.mutate(
      {
        ...values,
        poolSize: values.poolSize,
        maxClientConnections: values.maxClientConnections,
        allowedCidrs: values.allowedCidrs
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      },
      { onSuccess: (saved) => form.reset(valuesFrom(saved)) }
    )
  }
  const downloadCertificate = () => {
    if (!data.certificate) return
    const url = URL.createObjectURL(
      new Blob([data.certificate], { type: 'application/x-pem-file' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${data.projectId}-database.crt`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Form {...form}>
      <form
        id="self-hosted-database-configuration"
        onSubmit={form.handleSubmit(handleSubmit)}
        className="space-y-8"
      >
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Connection pooling</PageSectionTitle>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <Card>
              <CardContent>
                <FormField
                  control={form.control}
                  name="poolSize"
                  render={({ field }) => (
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label="Connection pool size"
                      description={`Connections per user and database. The database allows ${data.maxDatabaseConnections} connections in total; keep capacity available for internal services.`}
                    >
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={1}
                          max={Math.max(1, data.maxDatabaseConnections - 10)}
                          disabled={update.isPending}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </CardContent>
              <CardContent>
                <FormField
                  control={form.control}
                  name="maxClientConnections"
                  render={({ field }) => (
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label="Max client connections"
                      description="Maximum concurrent connections accepted by Supavisor."
                    >
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={1}
                          max={10000}
                          disabled={update.isPending}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </CardContent>
            </Card>
          </PageSectionContent>
        </PageSection>
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>SSL configuration</PageSectionTitle>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <Card>
              <CardContent>
                <FormField
                  control={form.control}
                  name="enforceSsl"
                  render={({ field }) => (
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label="Enforce SSL on incoming connections"
                      description="Reject unencrypted connections on the published session and transaction poolers. Internal services use the private database network."
                    >
                      <FormControl>
                        <Switch
                          aria-label="Enforce SSL on incoming connections"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={!data.tlsConfigured || update.isPending}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </CardContent>
              <CardContent className="space-y-3">
                <h3 className="text-sm">SSL certificate</h3>
                <p className="text-sm text-foreground-light">
                  Local TLS uses a project-specific certificate for localhost and 127.0.0.1.
                  Download and trust this certificate when using certificate verification.
                </p>
                {!data.tlsConfigured && data.localOnly && (
                  <Button
                    loading={update.isPending}
                    onClick={() => update.mutate({ configureTls: true })}
                  >
                    Configure local TLS
                  </Button>
                )}
                {data.tlsConfigured && (
                  <Button onClick={downloadCertificate}>Download certificate</Button>
                )}
                {!data.tlsConfigured && !data.localOnly && (
                  <p className="text-sm text-foreground-light">
                    Configure the host's TLS certificate before enforcing SSL.
                  </p>
                )}
              </CardContent>
            </Card>
          </PageSectionContent>
        </PageSection>
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Network restrictions</PageSectionTitle>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <Card>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="allowedCidrs"
                  render={({ field }) => (
                    <FormItemLayout
                      label="Allowed IP ranges"
                      description="One IPv4 or IPv6 CIDR per line. An empty list blocks all incoming pooler connections. Docker may translate client addresses to its gateway address."
                    >
                      <FormControl>
                        <Textarea {...field} rows={4} disabled={update.isPending} />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
                <Button
                  variant="danger"
                  disabled={update.isPending}
                  onClick={() => form.setValue('allowedCidrs', '', { shouldDirty: true })}
                >
                  Restrict all access
                </Button>
              </CardContent>
            </Card>
          </PageSectionContent>
        </PageSection>
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Connection logging</PageSectionTitle>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <Card>
              <CardContent>
                <FormField
                  control={form.control}
                  name="logConnections"
                  render={({ field }) => (
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label="Log connections"
                      description="Log successful database connections."
                    >
                      <FormControl>
                        <Switch
                          aria-label="Log connections"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={update.isPending}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </CardContent>
              <CardContent>
                <FormField
                  control={form.control}
                  name="logDisconnections"
                  render={({ field }) => (
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label="Log disconnections"
                      description="Log session endings and their duration."
                    >
                      <FormControl>
                        <Switch
                          aria-label="Log disconnections"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={update.isPending}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </CardContent>
              <CardFooter className="justify-end gap-2">
                {isDirty && (
                  <Button onClick={() => form.reset()} disabled={update.isPending}>
                    Cancel
                  </Button>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  loading={update.isPending}
                  disabled={!isDirty || update.isPending}
                >
                  {update.isPending ? 'Applying database settings...' : 'Save changes'}
                </Button>
              </CardFooter>
            </Card>
          </PageSectionContent>
        </PageSection>
      </form>
    </Form>
  )
}
