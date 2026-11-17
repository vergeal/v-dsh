/**
 * 消息列表的文本呈现。
 *
 * 独立于工具注册模块：`tools.js` 依赖 harness 的 `defineTool`，把纯文本逻辑放这里
 * 才能脱离运行时依赖单测，和 `messages.js`「自己不碰文件系统，便于单测」是同一分层。
 * @module hyt-im/render
 */

/**
 * 把消息列表渲染成紧凑文本：一行一条，正文压平。
 * @param {object} value - 工具返回值：`{account, self, count, hasMore, newestId, messages}`。
 * @returns {string} 渲染文本。
 */
export function renderMessages(value) {
  const lines = []
  lines.push(`账号 ${value.account}（本人 ${value.self}）｜命中 ${value.count} 条`
    + `${value.hasMore ? `，还有更多（最新 Id ${value.newestId}）` : ''}`)
  if (value.messages.length === 0) {
    lines.push('（无匹配消息）')
    return lines.join('\n')
  }
  for (const m of value.messages) {
    const arrow = m.direction === 'out' ? '→' : '←'
    const body = m.content.replaceAll('\n', ' ').replaceAll('\r', ' ')
    const clipped = m.contentTruncated ? '…' : ''
    const extra = [
      m.sessionType === 'group' ? '群' : '',
      m.msgTypeName !== '文本' ? m.msgTypeName : '',
      m.fileName ? `文件:${m.fileName}` : '',
      m.webTitle ? `链接:${m.webTitle}` : '',
      // 发送状态只对自己的消息有意义：收来的消息里 isSuccess 是本地落库水位，本机
      // 绝大多数是 0，标成「发送状态」会把别人发来的消息说成没发出去。
      m.direction === 'out' && m.isSuccess !== 1 ? `发送状态:${m.isSuccess}` : '',
    ].filter(Boolean).join(' ')
    lines.push(`#${m.id} ${m.time} ${arrow} ${m.peerNick}(${m.peer})${extra ? ` [${extra}]` : ''}: ${body}${clipped}`)
  }
  return lines.join('\n')
}
