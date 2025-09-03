import { z } from "zod";

/**
 - WiqlResponse (IDs only)
 - WorkItem (id, fields with common keys; extra fields allowed)
 - WorkItemUpdate (revisedDate, fields deltas)
 - PullRequest (selected fields)
 - PRThread (id, comments with author and publishedDate)
 - PRReviewer (id/uniqueName/displayName/vote)
 - PRIteration (id, createdDate)
 - PolicyEvaluation (configuration.type.displayName, status, started/completed)
 - GraphUser (id, displayName, uniqueName/email, descriptor)
 - AreaNode (id or path, name, children)
*/

// Common identity shape used by ADO responses
export const IdentityRefSchema = z
  .object({
    id: z.string().optional(),
    uniqueName: z.string().optional(),
    displayName: z.string().optional(),
    descriptor: z.string().optional(),
    url: z.string().optional(),
    imageUrl: z.string().optional(),
    mailAddress: z.string().optional(),
  })
  .catchall(z.unknown());
export type IdentityRef = z.infer<typeof IdentityRefSchema>;

// WiqlResponse (IDs only)
export const WiqlResponseSchema = z
  .object({
    workItems: z.array(z.object({ id: z.number() }).catchall(z.unknown())),
  })
  .catchall(z.unknown());
export type WiqlResponse = z.infer<typeof WiqlResponseSchema>;

// WorkItem fields (record with common fields called out)
export const WorkItemFieldsSchema = z
  .object({
    "System.State": z.string().optional(),
    "System.AssignedTo": z.union([IdentityRefSchema, z.string()]).optional(),
    "System.Title": z.string().optional(),
    "System.CreatedDate": z.string().optional(),
    "System.ChangedDate": z.string().optional(),
    "Microsoft.VSTS.Common.ClosedDate": z.string().optional(),
  })
  .catchall(z.unknown());
export type WorkItemFields = z.infer<typeof WorkItemFieldsSchema>;

export const WorkItemSchema = z
  .object({
    id: z.number(),
    fields: WorkItemFieldsSchema,
    url: z.string().optional(),
    rev: z.number().optional(),
  })
  .catchall(z.unknown());
export type WorkItem = z.infer<typeof WorkItemSchema>;

// WorkItemUpdate (fields deltas + revisedDate)
export const FieldDeltaSchema = z
  .object({
    oldValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
  })
  .catchall(z.unknown());
export type FieldDelta = z.infer<typeof FieldDeltaSchema>;

export const WorkItemUpdateSchema = z
  .object({
    id: z.number().optional(),
    rev: z.number().optional(),
    revisedDate: z.string().optional(),
    fields: FieldDeltaSchema,
  })
  .catchall(z.unknown());
export type WorkItemUpdate = z.infer<typeof WorkItemUpdateSchema>;

// PullRequest
export const PullRequestSchema = z
  .object({
    id: z.number(),
    createdBy: IdentityRefSchema,
    creationDate: z.string(),
    status: z.string(),
    isDraft: z.boolean().optional(),
    targetRefName: z.string(),
    sourceRefName: z.string(),
    closedDate: z.string().optional(),
  })
  .catchall(z.unknown());
export type PullRequest = z.infer<typeof PullRequestSchema>;

// PRThread with comments (author + publishedDate)
export const PRCommentSchema = z
  .object({
    id: z.number().optional(),
    author: IdentityRefSchema.optional(),
    content: z.string().optional(),
    publishedDate: z.string(),
  })
  .catchall(z.unknown());
export type PRComment = z.infer<typeof PRCommentSchema>;

export const PRThreadSchema = z
  .object({
    id: z.number(),
    comments: z.array(PRCommentSchema),
  })
  .catchall(z.unknown());
export type PRThread = z.infer<typeof PRThreadSchema>;

// PRReviewer
export const PRReviewerSchema = z
  .object({
    id: z.string(),
    uniqueName: z.string().optional(),
    displayName: z.string(),
    vote: z.number().int(),
  })
  .catchall(z.unknown());
export type PRReviewer = z.infer<typeof PRReviewerSchema>;

// PRIteration
export const PRIterationSchema = z
  .object({
    id: z.number().int(),
    createdDate: z.string(),
  })
  .catchall(z.unknown());
export type PRIteration = z.infer<typeof PRIterationSchema>;

// PolicyEvaluation
export const PolicyConfigurationTypeSchema = z
  .object({
    displayName: z.string(),
  })
  .catchall(z.unknown());
export type PolicyConfigurationType = z.infer<
  typeof PolicyConfigurationTypeSchema
>;

export const PolicyEvaluationSchema = z
  .object({
    configuration: z
      .object({
        type: PolicyConfigurationTypeSchema,
      })
      .catchall(z.unknown()),
    status: z.string(),
    startedDate: z.string().optional(),
    completedDate: z.string().optional(),
  })
  .catchall(z.unknown());
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

// GraphUser
export const GraphUserSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    uniqueName: z.string().optional(),
    mailAddress: z.string().optional(),
    descriptor: z.string().optional(),
  })
  .catchall(z.unknown());
export type GraphUser = z.infer<typeof GraphUserSchema>;

// AreaNode (recursive)
export type AreaNode = {
  id?: number;
  path?: string;
  name: string;
  children?: AreaNode[];
  [k: string]: unknown;
};

export const AreaNodeSchema: z.ZodType<AreaNode> = z.lazy(() =>
  z
    .object({
      id: z.number().optional(),
      path: z.string().optional(),
      name: z.string(),
      children: z.array(AreaNodeSchema).optional(),
    })
    .catchall(z.unknown())
);
