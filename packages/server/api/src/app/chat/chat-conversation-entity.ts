import { ChatConversation, Platform, Project, User } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type ChatConversationSchema = ChatConversation & {
    platform: Platform
    project: Project | null
    user: User
}

export const ChatConversationEntity = new EntitySchema<ChatConversationSchema>({
    name: 'chat_conversation',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        // Nullable because the chat opens before a project is picked: the shared contract has the
        // model select one mid-conversation, so the row has to exist without one.
        projectId: {
            ...ApIdSchema,
            nullable: true,
        },
        userId: {
            ...ApIdSchema,
            nullable: false,
        },
        title: {
            type: String,
            nullable: true,
        },
        modelName: {
            type: String,
            nullable: true,
        },
        status: {
            type: String,
            nullable: false,
        },
        // Two histories, because the shared `ChatConversation` contract declares both and the web
        // client reads `uiMessages`. `uiMessages` is the live one: it is schema-validated, it is
        // what the client renders, and it is what the next turn's transcript is rebuilt from.
        // `messages` is a write-only record of what was last sent to the provider — the AI SDK
        // exports no runtime schema for `ModelMessage`, so reading it back would need a cast this
        // repo does not allow. Nothing is lost by replaying from `uiMessages`: cross-turn
        // reasoning is stripped for every provider anyway (`chatAiUtils.stripThinkingBlocks`),
        // and the tool-call/result pairs survive.
        messages: {
            type: 'json',
            nullable: false,
            default: '[]',
        },
        uiMessages: {
            type: 'json',
            nullable: true,
        },
        summary: {
            type: String,
            nullable: true,
        },
        summarizedUpToIndex: {
            type: Number,
            nullable: true,
        },
    },
    indices: [
        // Matches the only list query there is — a user's own conversations, newest first.
        {
            name: 'idx_chat_conversation_platform_id_user_id_created',
            columns: ['platformId', 'userId', 'created'],
            unique: false,
        },
    ],
    relations: {
        platform: {
            type: 'many-to-one',
            target: 'platform',
            nullable: false,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_chat_conversation_platform_id',
            },
        },
        project: {
            type: 'many-to-one',
            target: 'project',
            nullable: true,
            // SET NULL rather than CASCADE: deleting a project should not silently destroy the
            // user's chat history with it, and the column is already nullable by design.
            onDelete: 'SET NULL',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_chat_conversation_project_id',
            },
        },
        user: {
            type: 'many-to-one',
            target: 'user',
            nullable: false,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'userId',
                foreignKeyConstraintName: 'fk_chat_conversation_user_id',
            },
        },
    },
})
