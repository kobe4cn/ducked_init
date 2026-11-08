// app/.server/publish-rules.ts —— 双人发布规则（ADR-0015）已并入 publishing.ts（ADR-0051），这里只剩转发；
// 引用它的调用方（mappings、passthrough、merge-groups、custom-entities、templates、dsl-definitions 与路由）在 #500 一并改过去
export { isStale, publishBlocker, publishReason, publisherCount, withAuthor } from './publishing';
