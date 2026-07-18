/** ThinkingIndicator(T8 转交)—— busy 时 spinner + thinking...。
 *
 *  T4.5 感知:后台 shell 在跑时本行**常驻**(idle 也显示,spinner 转着 + 已运行秒数
 *  每秒自增),让「后台有活」在正文区一眼可见,而非只藏在状态栏;busy 时并进
 *  thinking 行(单行不叠)。全部退出即整行消失。字符纪律:纯 ASCII + CJK,无
 *  ambiguous-width 字符。
 *  Boundary(HOST 层):react + ink + 相对 import。 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner';
import { useTheme } from '../providers/theme';

export function ThinkingIndicator(props: { busy?: boolean; bgShells?: number }): React.ReactElement | null {
  const theme = useTheme();
  const bg = props.bgShells ?? 0;
  // 后台计时:bg 0→>0 记起点,归零清空;idle 期间每秒重渲一次推进秒数。
  const startRef = useRef<number | null>(null);
  if (bg > 0 && startRef.current == null) startRef.current = Date.now();
  if (bg === 0) startRef.current = null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (bg === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [bg]);

  if (!props.busy && bg === 0) return null;
  const bgSecs = startRef.current != null ? Math.floor((Date.now() - startRef.current) / 1000) : 0;
  const bgText = bg > 0 ? `后台任务 ${bg} 运行中 (${bgSecs}s)` : '';
  return (
    <Box>
      <Spinner />
      {props.busy ? <Text color={theme.dim}> thinking...{bgText ? ` | ${bgText}` : ''}</Text> : <Text> {bgText}</Text>}
    </Box>
  );
}
