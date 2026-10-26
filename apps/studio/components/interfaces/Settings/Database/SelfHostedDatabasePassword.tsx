import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Button, Card, CardContent, CardFooter, Form, FormControl, FormField, Input } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { z } from 'zod'

import { useSelfHostedPasswordResetMutation } from '@/data/config/self-hosted-database-settings'

const schema = z.object({
  password: z
    .string()
    .regex(
      /^[A-Za-z0-9._~-]{20,128}$/,
      'Use 20–128 letters, numbers, periods, hyphens, underscores, or tildes'
    ),
})

export const SelfHostedDatabasePassword = () => {
  const [isEditing, setIsEditing] = useState(false)
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: '' },
  })
  const { isDirty } = form.formState
  const reset = useSelfHostedPasswordResetMutation()
  return (
    <PageSection>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>Database password</PageSectionTitle>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(({ password }) =>
              reset.mutate(password, {
                onSuccess: () => {
                  form.reset({ password: '' })
                  setIsEditing(false)
                },
              })
            )}
          >
            <Card>
              <CardContent className="space-y-4">
                <p className="text-sm text-foreground-light">
                  Resetting updates the database roles and reconnects project services. Existing
                  external connections must use the new password. The project is briefly
                  unavailable.
                </p>
                {!isEditing && <Button onClick={() => setIsEditing(true)}>Reset password</Button>}
                {isEditing && (
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItemLayout label="New database password">
                        <FormControl>
                          <Input
                            {...field}
                            type="password"
                            autoComplete="new-password"
                            disabled={reset.isPending}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                )}
                {reset.isPending && (
                  <p role="status" className="text-sm text-foreground-light">
                    Resetting database password and reconnecting services. This can take a few
                    minutes.
                  </p>
                )}
              </CardContent>
              {isEditing && (
                <CardFooter className="justify-end gap-2">
                  <Button
                    disabled={reset.isPending}
                    onClick={() => {
                      form.reset()
                      setIsEditing(false)
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!isDirty || reset.isPending}
                    loading={reset.isPending}
                  >
                    {reset.isPending ? 'Resetting password...' : 'Reset password'}
                  </Button>
                </CardFooter>
              )}
            </Card>
          </form>
        </Form>
      </PageSectionContent>
    </PageSection>
  )
}
