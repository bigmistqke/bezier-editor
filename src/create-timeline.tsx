import clsx from 'clsx'
import {
  Accessor,
  ComponentProps,
  createContext,
  createEffect,
  createSignal,
  Index,
  onCleanup,
  ParentProps,
  Setter,
  Show,
  splitProps,
  useContext,
} from 'solid-js'
import { createStore, produce, SetStoreFunction } from 'solid-js/store'
import { createLookupMap } from './lib/create-cubic-lookup-map'
import { dFromAbsoluteAnchors } from './lib/d-from-anchors'
import { getValueFromSegments } from './lib/get-value-from-segments'
import { addVector, divideVector, subtractVector } from './lib/vector'
import { useSheet } from './sheet'
import styles from './timeline.module.css'
import type { Anchor, Anchors, Segment, Vector } from './types'
import { createIndexMemo } from './utils/create-index-memo'
import { createWritable } from './utils/create-writable'
import { once, whenMemo } from './utils/once-every-when'
import { pointerHelper } from './utils/pointer-helper'

function createTimelineComponent({
  getValue,
  addAnchor,
  d,
  absoluteAnchors,
  setAnchors,
  deleteAnchor,
}: Api) {
  /**********************************************************************************/
  /*                                                                                */
  /*                                     Handle                                     */
  /*                                                                                */
  /**********************************************************************************/

  const [draggingHandle, setDraggingHandle] = createSignal(false)

  function Handle(props: {
    position: Vector
    onDragStart(event: MouseEvent): Promise<void>
    onDblClick?(e: MouseEvent): void
  }) {
    const { project } = useTimeline()

    const [active, setActive] = createSignal(false)

    async function onPointerDown(event: MouseEvent) {
      setActive(true)
      setDraggingHandle(true)

      await props.onDragStart(event)

      setActive(false)
      setDraggingHandle(false)
    }

    return (
      <g class={clsx(styles.handleContainer, active() && styles.active)}>
        <circle
          cx={project(props.position, 'x')}
          cy={project(props.position, 'y')}
          fill="transparent"
          onDblClick={(e) => {
            if (props.onDblClick) {
              e.stopPropagation()
              props.onDblClick(e)
            }
          }}
          onPointerDown={onPointerDown}
          r="10"
          style={{ cursor: 'move' }}
        />
        <circle
          class={styles.handle}
          cx={project(props.position, 'x')}
          cy={project(props.position, 'y')}
          r="3"
          style={{ 'pointer-events': 'none' }}
        />
      </g>
    )
  }

  /**********************************************************************************/
  /*                                                                                */
  /*                                     Control                                     */
  /*                                                                                */
  /**********************************************************************************/

  function Control(props: {
    position: Vector
    control: Vector
    onDragStart(event: MouseEvent): Promise<void>
  }) {
    const { project } = useTimeline()
    const [, rest] = splitProps(props, ['control', 'position'])
    return (
      <g class={styles.controlContainer}>
        <line
          stroke="black"
          x1={project(props.position, 'x')}
          y1={project(props.position, 'y')}
          x2={project(props.control, 'x')}
          y2={project(props.control, 'y')}
          style={{ 'pointer-events': 'none' }}
        />
        <Handle position={props.control} {...rest} />
      </g>
    )
  }

  /**********************************************************************************/
  /*                                                                                */
  /*                                     Anchor                                     */
  /*                                                                                */
  /**********************************************************************************/

  function Anchor(props: {
    onDeleteAnchor(): void
    onControlDragStart(type: 'pre' | 'post', event: MouseEvent): Promise<void>
    onPositionDragStart(event: MouseEvent): Promise<void>
    position: Vector
    post?: Vector
    pre?: Vector
  }) {
    return (
      <>
        <Show when={props.pre}>
          <Control
            position={props.position}
            control={props.pre!}
            onDragStart={(event) => props.onControlDragStart('pre', event)}
          />
        </Show>
        <Show when={props.post}>
          <Control
            position={props.position}
            control={props.post!}
            onDragStart={(event) => props.onControlDragStart('post', event)}
          />
        </Show>
        <Handle
          position={props.position}
          onDragStart={(event) => props.onPositionDragStart(event)}
          onDblClick={props.onDeleteAnchor}
        />
      </>
    )
  }

  /**********************************************************************************/
  /*                                                                                */
  /*                                 Time Indicator                                 */
  /*                                                                                */
  /**********************************************************************************/

  function Indicator(props: { height: number; time: number; class?: string }) {
    const { project } = useTimeline()

    return (
      <g class={clsx(styles.timeIndicator, props.class)}>
        <line
          y1={0}
          y2={props.height}
          x1={project(props.time, 'x')}
          x2={project(props.time, 'x')}
        />
        <circle
          cx={project(props.time, 'x')}
          cy={project(getValue(props.time), 'y')!}
          r={3}
        />
      </g>
    )
  }

  /**********************************************************************************/
  /*                                                                                */
  /*                                Timeline Context                                */
  /*                                                                                */
  /**********************************************************************************/

  const TimelineContext = createContext<{
    origin: Accessor<Vector>
    zoom: Accessor<Vector>
    project(point: Vector | number, type: 'x' | 'y'): number
    unproject(point: Vector | number, type: 'x' | 'y'): number
  }>()

  function useTimeline() {
    const context = useContext(TimelineContext)
    if (!context) {
      throw `useTimeline should be used in a descendant of Timeline`
    }
    return context
  }

  /**********************************************************************************/
  /*                                                                                */
  /*                                    Timeline                                    */
  /*                                                                                */
  /**********************************************************************************/

  return function Timeline(
    props: ComponentProps<'svg'> & {
      max: number
      min: number
      onPan?(pan: number): void
      onTimeChange?(time: number): void
      onZoomChange?(zoom: Vector): void
      zoomY?: number
    }
  ) {
    const sheet = useSheet()
    const [config, rest] = splitProps(props, [
      'max',
      'min',
      'onPan',
      'onTimeChange',
      'onZoomChange',
      'zoomY',
    ])

    const [domRect, setDomRect] = createSignal<DOMRect>()
    const [paddingMax, setPaddingMax] = createSignal(0)
    const [paddingMin, setPaddingMin] = createSignal(0)
    const [presence, setPresence] = createSignal<number | undefined>(undefined)

    const zoom = whenMemo(
      domRect,
      (domRect) => ({
        x: sheet.zoomX(),
        y:
          (domRect.height /
            (props.max + paddingMax() + paddingMin() - props.min * 2)) *
          (config.zoomY || 1),
      }),
      { x: 1, y: 1 }
    )

    const origin = {
      get x() {
        return sheet.pan()
      },
      get y() {
        return (paddingMin() - props.min) / (config.zoomY || 1)
      },
    }

    function project(point: Vector | number, type: 'x' | 'y') {
      const value = typeof point === 'object' ? point[type] : point
      return (value + origin[type]) * zoom()[type]
    }

    function unproject(point: Vector | number, type: 'x' | 'y') {
      const value = typeof point === 'object' ? point[type] : point
      return (value + origin[type]) / zoom()[type]
    }

    function getPairedAnchorPosition(
      type: 'pre' | 'post',
      index: number
    ): undefined | Vector {
      if (type === 'pre' && index === 0) {
        return undefined
      }
      if (type === 'post' && index === absoluteAnchors().length - 1) {
        return undefined
      }
      return absoluteAnchors()[type === 'pre' ? index - 1 : index + 1][0]
    }

    /**
     * `absoluteToRelativeControl` applies 3 operations on the given absolute control-vector:
     * - Clamps absolute x-value to ensure monotonicity of the curve
     * - Absolute x-value to relative x-value (range 0-1)
     * - Absolute y-value to relative y-value (offset from position)
     */
    function absoluteToRelativeControl({
      type,
      index,
      absoluteControl,
    }: {
      type: 'pre' | 'post'
      index: number
      absoluteControl: Vector
    }) {
      const [position] = absoluteAnchors()[index]
      const pairedPosition = getPairedAnchorPosition(type, index)

      if (!pairedPosition) {
        throw `Attempting to process a control without a paired anchor.`
      }

      const [min, max] =
        type === 'post'
          ? [position, pairedPosition]
          : [pairedPosition, position]

      // Clamp x to ensure monotonicity of the curve (https://en.wikipedia.org/wiki/Monotonic_function)
      const x = Math.max(min.x, Math.min(max.x, absoluteControl.x))

      return {
        // Absolute value to absolute offset from position
        y: Math.floor(absoluteControl.y - position.y),
        // Absolute value to relative range [0-1]
        x: Math.abs(position.x - x) / Math.abs(position.x - pairedPosition.x),
      }
    }

    async function onControlDragStart({
      type,
      event,
      anchor: [position, controls],
      index,
    }: {
      type: 'pre' | 'post'
      event: MouseEvent
      anchor: Anchor
      index: number
    }) {
      const initialControl = { ...controls![type]! }

      const prePosition = getPairedAnchorPosition('pre', index)
      const postPosition = getPairedAnchorPosition('post', index)
      const preRange = prePosition && subtractVector(position, prePosition)
      const postRange = postPosition && subtractVector(position, postPosition)

      const pairedType = type === 'pre' ? 'post' : 'pre'
      const ratio =
        preRange && postRange
          ? type === 'pre'
            ? postRange.x / preRange.x
            : preRange.x / postRange.x
          : undefined

      await pointerHelper(event, ({ delta, event }) => {
        delta = divideVector(delta, zoom())

        const absoluteControl = subtractVector(initialControl, delta)
        const control = absoluteToRelativeControl({
          index,
          type,
          absoluteControl,
        })
        setAnchors(index, 1, type, control)

        // Symmetric dragging of paired control
        if (event.metaKey && ratio) {
          setAnchors(index, 1, pairedType, {
            x: control.x,
            y: control.y * ratio,
          })
        }
      })

      updatePadding()
    }

    async function onPositionDragStart({
      anchor,
      event,
      index,
    }: {
      anchor: Anchor
      event: MouseEvent
      index: number
    }) {
      const initialPosition = { ...anchor[0] }

      const pre = getPairedAnchorPosition('pre', index)
      const post = getPairedAnchorPosition('post', index)

      await pointerHelper(event, ({ delta }) => {
        delta = divideVector(delta, zoom())

        const position = subtractVector(initialPosition, delta)

        // Clamp position with the pre-anchor's position
        if (pre && position.x - 1 < pre.x) {
          position.x = pre.x + 1
        }

        // Clamp position with the pre-anchor's position
        if (post && position.x + 1 > post.x) {
          position.x = post.x - 1
        }

        setAnchors(index, 0, position)
      })

      updatePadding()
    }

    function maxPaddingFromVector(value: Vector) {
      return Math.max(value.y, props.max) - props.max + 100
    }
    function minPaddingFromVector(value: Vector) {
      return props.min - Math.min(value.y, props.min) + 100
    }

    function updatePadding() {
      let min = 0
      let max = 0
      absoluteAnchors().forEach(([anchor, { pre, post } = {}]) => {
        min = Math.max(min, minPaddingFromVector(anchor))
        max = Math.max(max, maxPaddingFromVector(anchor))
        if (pre) {
          min = Math.max(min, minPaddingFromVector(pre))
          max = Math.max(max, maxPaddingFromVector(pre))
        }
        if (post) {
          min = Math.max(min, minPaddingFromVector(post))
          max = Math.max(max, maxPaddingFromVector(post))
        }
      })

      setPaddingMin(min)
      setPaddingMax(max)
    }

    return (
      <TimelineContext.Provider
        value={{
          origin: () => origin,
          zoom,
          project,
          unproject,
        }}
      >
        <svg
          ref={(element) => {
            function updateDomRect() {
              setDomRect(element.getBoundingClientRect())
            }
            const observer = new ResizeObserver(updateDomRect)
            observer.observe(element)
            updateDomRect()
            onCleanup(() => observer.disconnect())

            updatePadding()
            createEffect(() => props.onZoomChange?.(zoom()))
            createEffect(() => props.onPan?.(sheet.pan()))
          }}
          width="100%"
          height="100%"
          class={clsx(props.class, styles.timeline)}
          {...rest}
          onPointerDown={async (event) => {
            if (event.target !== event.currentTarget) {
              console.log(event.target)
              return
            }
            if (event.metaKey) {
              const x = sheet.pan()
              await pointerHelper(event, ({ delta, event }) => {
                sheet.setPan(x - delta.x / zoom().x)
                setPresence(event.layerX / zoom().x - sheet.pan())
              })
            }
          }}
          onPointerMove={(e) => {
            setPresence(e.layerX / zoom().x - sheet.pan())
          }}
          onPointerLeave={() => {
            setPresence(undefined)
          }}
          onDblClick={() => {
            once(presence, addAnchor)
          }}
          onWheel={(e) => {
            sheet.setPan((pan) => pan + e.deltaX)
          }}
        >
          <path
            class={styles.path}
            d={d({ zoom: zoom(), origin: origin })}
            style={{ 'pointer-events': 'none' }}
          />
          <Show when={!draggingHandle() && presence()}>
            {(presence) => (
              <Indicator
                height={window.innerHeight}
                time={presence()}
                class={styles.presence}
              />
            )}
          </Show>
          <Indicator height={window.innerHeight} time={sheet.time()} />
          <Index each={absoluteAnchors()}>
            {(anchor, index) => {
              const position = () => anchor()[0]
              const control = (type: 'pre' | 'post') => anchor()[1]?.[type]
              return (
                <Anchor
                  position={position()}
                  pre={control('pre')}
                  post={control('post')}
                  onDeleteAnchor={() => deleteAnchor(index)}
                  onControlDragStart={(type, event) =>
                    onControlDragStart({ type, event, index, anchor: anchor() })
                  }
                  onPositionDragStart={(event) =>
                    onPositionDragStart({ event, index, anchor: anchor() })
                  }
                />
              )
            }}
          </Index>
          {props.children}
        </svg>
      </TimelineContext.Provider>
    )
  }
}

/**********************************************************************************/
/*                                                                                */
/*                                     Value                                    */
/*                                                                                */
/**********************************************************************************/

const ValueContext = createContext<{
  value: Accessor<number>
  setValue: Setter<number>
}>()
const useValue = () => {
  const context = useContext(ValueContext)
  if (!context) {
    throw `useValue should be used in a descendant of Value`
  }
  return context
}

function createValueComponent({ addAnchor, getValue }: Api) {
  function Value(props: ParentProps) {
    const { time } = useSheet()
    const [value, setValue] = createWritable(() => getValue(time()))

    return (
      <ValueContext.Provider value={{ value, setValue }}>
        {props.children}
      </ValueContext.Provider>
    )
  }

  Value.Button = function (props: Omit<ComponentProps<'button'>, 'click'>) {
    const { time } = useSheet()
    const { value } = useValue()

    return (
      <button
        onClick={() => {
          addAnchor(time(), value())
        }}
        {...props}
      />
    )
  }

  Value.Input = function (
    props: Omit<ComponentProps<'input'>, 'onInput' | 'value'> & {
      decimals?: number
    }
  ) {
    const { value, setValue } = useValue()

    return (
      <input
        type="number"
        value={props.decimals ? value().toFixed(props.decimals) : value()}
        onInput={(e) => setValue(+e.currentTarget.value)}
        {...props}
      />
    )
  }

  return Value
}

/**********************************************************************************/
/*                                                                                */
/*                                 Create Timeline                                */
/*                                                                                */
/**********************************************************************************/

type Api = {
  absoluteAnchors: Accessor<Array<Anchor>>
  anchors: Accessor<Array<Anchor>>
  d(config?: { zoom?: Partial<Vector>; origin?: Partial<Vector> }): string
  getValue(time: number): number
  setAnchors: SetStoreFunction<Array<Anchor>>
  deleteAnchor(index: number): void
  addAnchor(time: number, value?: number): void
}

export function createTimeline(config?: { initial?: Anchors }) {
  const [anchors, setAnchors] = createStore<Anchors>(config?.initial || [])

  const absoluteAnchors = createIndexMemo(
    () => anchors,
    ([point, relativeControls], index) => {
      const controls: { pre?: Vector; post?: Vector } = {
        pre: undefined,
        post: undefined,
      }

      const pre = relativeControls?.pre
      if (pre) {
        const prev = anchors[index - 1][0]
        const deltaX = point.x - prev.x
        controls.pre = addVector(point, {
          x: deltaX * pre.x * -1,
          y: pre.y,
        })
      }

      const post = relativeControls?.post
      if (post) {
        const next = anchors[index + 1][0]
        const deltaX = next.x - point.x
        controls.post = addVector(point, {
          x: deltaX * post.x,
          y: post.y,
        })
      }

      return [point, controls] as Anchor
    }
  )

  const lookupMapSegments = createIndexMemo(absoluteAnchors, (point, index) => {
    const next = absoluteAnchors()[index + 1]
    return next
      ? {
          range: [point[0].x, next[0].x],
          map: createLookupMap(point, next),
        }
      : undefined
  })

  function d(config?: { zoom?: Partial<Vector>; origin?: Partial<Vector> }) {
    return dFromAbsoluteAnchors(absoluteAnchors(), config)
  }

  function getValue(time: number) {
    const segments = lookupMapSegments().slice(0, -1) as Array<Segment>
    return getValueFromSegments(segments, time)
  }

  function addAnchor(time: number, value = getValue(time)) {
    setAnchors(
      produce((anchors) => {
        let index = anchors.findIndex(([anchor]) => {
          return anchor.x > time
        })
        if (index === -1) {
          anchors[anchors.length - 1][1] = {
            ...anchors[anchors.length - 1][1],
            post: { x: 0.5, y: 0 },
          }
          anchors.push([{ x: time, y: value }, { pre: { x: 0.5, y: 0 } }])
        } else if (index === 0) {
          anchors[0][1] = {
            ...anchors[0][1],
            pre: { x: 0.5, y: 0 },
          }
          anchors.unshift([{ x: time, y: value }, { post: { x: 0.5, y: 0 } }])
        } else {
          anchors.splice(index, 0, [
            { x: time, y: value },
            { pre: { x: 0.5, y: 0 }, post: { x: 0.5, y: 0 } },
          ])
        }
      })
    )
  }

  function deleteAnchor(index: number) {
    setAnchors(produce((anchors) => anchors.splice(index, 1)))
  }

  const api: Api = {
    absoluteAnchors,
    anchors: () => anchors,
    addAnchor,
    d,
    deleteAnchor,
    getValue,
    setAnchors,
  }

  return {
    ...api,
    Value: createValueComponent(api),
    Component: createTimelineComponent(api),
  }
}
