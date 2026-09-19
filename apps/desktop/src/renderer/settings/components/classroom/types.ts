/**
 * ClassRoom 配置子组件的共享契约（docs/05 §3、docs/08 §7）。
 *
 * 拆文件时最容易踩的坑是**写盘语义**：`settings:update` 只做顶层分组浅合并，
 * `modes.classroom` 是整体替换的对象，因此「展开当前值再覆盖改动」这件事
 * 必须集中在一处。这里把容器的方法以**回调 prop** 的形式下传：
 * 子组件只描述「哪个字段变成什么」，不自己拼 `modes` 对象，也不自己调 IPC。
 */
import type { ClassroomModeConfig } from '@aurora/shared'

/** 提交一处改动；容器负责浅合并写盘并返回是否成功 */
export type ClassroomPatch = (change: Partial<ClassroomModeConfig>) => Promise<boolean>

export type NoticeTone = 'ok' | 'warn' | 'error'

/** 把结果回传给容器统一展示（整块配置区只有一个 toast 位置，避免四处飘提示） */
export type ClassroomNotify = (payload: { tone: NoticeTone; text: string }) => void
