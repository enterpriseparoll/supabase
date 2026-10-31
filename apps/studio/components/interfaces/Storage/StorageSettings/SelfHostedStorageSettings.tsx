import { zodResolver } from '@hookform/resolvers/zod'
import { useParams } from 'common'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
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
} from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { PageContainer } from 'ui-patterns/PageContainer'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import { z } from 'zod'

import { AlertError } from '@/components/ui/AlertError'
import { useProjectStorageConfigQuery } from '@/data/config/project-storage-config-query'
import { useProjectStorageConfigUpdateUpdateMutation } from '@/data/config/project-storage-config-update-mutation'

const schema = z.object({
  fileSizeLimit: z
    .union([z.literal(''), z.coerce.number().int().min(1).max(512000)])
    .refine((value) => value !== '', 'File size limit is required'),
  imageTransformation: z.boolean(),
  s3Protocol: z.boolean(),
})
type Values = z.infer<typeof schema>
const defaults: Values = { fileSizeLimit: 50, imageTransformation: false, s3Protocol: true }

export const SelfHostedStorageSettings = () => {
  const { ref: projectRef } = useParams()
  const { data, error, isPending } = useProjectStorageConfigQuery({ projectRef })
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
    values: data
      ? {
          fileSizeLimit: data.fileSizeLimit / 1024 ** 2,
          imageTransformation: data.features.imageTransformation.enabled,
          s3Protocol: data.features.s3Protocol.enabled,
        }
      : defaults,
    resetOptions: { keepDirtyValues: true },
  })
  const { isDirty } = form.formState
  const { mutate, isPending: isSaving } = useProjectStorageConfigUpdateUpdateMutation({
    onSuccess: (saved) => {
      if (!saved) return
      form.reset({
        fileSizeLimit: saved.fileSizeLimit / 1024 ** 2,
        imageTransformation: saved.features.imageTransformation.enabled,
        s3Protocol: saved.features.s3Protocol.enabled,
      })
      toast.success('Storage settings saved')
    },
  })
  const handleSubmit = (values: Values) => {
    if (!projectRef) return
    mutate({
      projectRef,
      fileSizeLimit: values.fileSizeLimit * 1024 ** 2,
      features: {
        imageTransformation: { enabled: values.imageTransformation },
        s3Protocol: { enabled: values.s3Protocol },
      },
    })
  }
  if (isPending) return <GenericSkeletonLoader />
  if (error) return <AlertError error={error} subject="Failed to retrieve storage settings" />
  const canUpdate = data.selfHosted?.canUpdate ?? false
  return (
    <PageContainer>
      <PageSection>
        <PageSectionContent className="space-y-6">
          <Admonition
            type="default"
            title="Storage configuration"
            description={
              canUpdate
                ? 'Saving restarts the Storage service. File uploads and downloads are briefly unavailable while the changes take effect.'
                : 'Update FILE_SIZE_LIMIT, ENABLE_IMAGE_TRANSFORMATION, and S3_PROTOCOL_ENABLED in your Storage server environment, then restart the service.'
            }
          />
          <Form {...form}>
            <form id="self-hosted-storage-settings" onSubmit={form.handleSubmit(handleSubmit)}>
              <Card>
                <CardContent>
                  <FormField
                    control={form.control}
                    name="fileSizeLimit"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Global file size limit (MiB)"
                        description="Maximum upload size across all buckets. Individual bucket limits must be smaller."
                      >
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            min={1}
                            max={512000}
                            disabled={!canUpdate || isSaving}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={form.control}
                    name="imageTransformation"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Image transformations"
                        description="Resize and optimize images through the configured imgproxy service."
                      >
                        <FormControl>
                          <Switch
                            aria-label="Image transformations"
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            disabled={!canUpdate || isSaving}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={form.control}
                    name="s3Protocol"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="S3 protocol"
                        description="Allow S3-compatible clients to access file buckets."
                      >
                        <FormControl>
                          <Switch
                            aria-label="S3 protocol"
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            disabled={!canUpdate || isSaving}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                {canUpdate && (
                  <CardFooter className="justify-end gap-2">
                    {isDirty && (
                      <Button variant="default" onClick={() => form.reset()} disabled={isSaving}>
                        Cancel
                      </Button>
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!isDirty || isSaving}
                      loading={isSaving}
                    >
                      {isSaving ? 'Applying storage settings...' : 'Save changes'}
                    </Button>
                  </CardFooter>
                )}
              </Card>
            </form>
          </Form>
        </PageSectionContent>
      </PageSection>
    </PageContainer>
  )
}
