'use client';

import type { Variants } from 'motion/react';
import { motion, useAnimation } from 'motion/react';
import type { HTMLAttributes } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';

import { cn } from '@/lib/utils';

export interface MessageCircleIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface MessageCircleIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const bubbleVariants: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 0.94, 1],
    transition: { duration: 0.5 },
  },
};

// The dots read as "someone is composing a reply", which is what a chat entry point
// promises. Staggering them is the whole signal — three dots appearing at once look
// like decoration rather than typing.
const dotVariants: Variants = {
  normal: { opacity: 1, y: 0 },
  animate: (index: number) => ({
    opacity: [0.3, 1, 0.3],
    y: [0, -1.5, 0],
    transition: { duration: 0.6, delay: index * 0.12 },
  }),
};

const MessageCircleIcon = forwardRef<
  MessageCircleIconHandle,
  MessageCircleIconProps
>(({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
  const controls = useAnimation();
  const isControlledRef = useRef(false);

  useImperativeHandle(ref, () => {
    isControlledRef.current = true;

    return {
      startAnimation: () => controls.start('animate'),
      stopAnimation: () => controls.start('normal'),
    };
  });

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isControlledRef.current) {
        onMouseEnter?.(e);
      } else {
        controls.start('animate');
      }
    },
    [controls, onMouseEnter],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isControlledRef.current) {
        onMouseLeave?.(e);
      } else {
        controls.start('normal');
      }
    },
    [controls, onMouseLeave],
  );

  return (
    <div
      className={cn(className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...props}
    >
      <svg
        className="overflow-visible"
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <motion.path
          animate={controls}
          d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"
          variants={bubbleVariants}
        />
        {[8, 12, 16].map((cx, index) => (
          <motion.circle
            animate={controls}
            custom={index}
            cx={cx}
            cy={12}
            fill="currentColor"
            key={cx}
            r={1}
            stroke="none"
            variants={dotVariants}
          />
        ))}
      </svg>
    </div>
  );
});

MessageCircleIcon.displayName = 'MessageCircleIcon';

export { MessageCircleIcon };
