import clsx from 'clsx'
import {
  Accessor,
  ComponentProps,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  splitProps,
  useContext,
} from 'solid-js'
import { createStore, produce, SetStoreFunction } from 'solid-js/store'
import { createLookupMap } from './lib/create-cubic-lookup-map'
import { dFromAbsoluteAnchors } from './lib/d-from-anchors'
import { getValueFromSegments } from './lib/get-value-from-segments'
import { vector } from './lib/vector'
import styles from './timeline.module.css'
import type { Anchor, Anchors, Segment, Vector } from './types'
import { createIndexMemo } from './utils/create-index-memo'
import { whenMemo } from './utils/once-every-when'
import { pointerHelper } from './utils/pointer-helper'

/**********************************************************************************/
/*                                                                                */
/*                                     Handle                                     */
/*                                                                                */
/**********************************************************************************/

const [draggingHandle, setDraggingHandle] = createSignal(false)

function Handle(props: {
  position: Vector
  onChange(position: Vector, delta: Vector, event: MouseEvent): void
  onChangeEnd(): void
  onDblClick?(e: MouseEvent): void
}) {
  const { project, zoom } = useTimeline()

  const [active, setActive] = createSignal(false)

  async function onPointerDown(e: MouseEvent) {
    setActive(true)
    setDraggingHandle(true)

    const position = { ...props.position }

    await pointerHelper(e, (delta) => {
      delta = vector.divide(delta, zoom())
      props.onChange(vector.subtract(position, delta), delta, e)
    })

    props.onChangeEnd()
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
  onChange(position: Vector, delta: Vector, event: MouseEvent): void
  onChangeEnd(): void
}) {
  const { project } = useTimeline()
  const [, rest] = splitProps(props, ['control', 'position'])
  return (
    <>
      <line
        stroke="black"
        x1={project(props.position, 'x')}
        y1={project(props.position, 'y')}
        x2={project(props.control, 'x')}
        y2={project(props.control, 'y')}
        style={{ 'pointer-events': 'none' }}
      />
      <Handle position={props.control} {...rest} />
    </>
  )
}

/**********************************************************************************/
/*                                                                                */
/*                                     Anchor                                     */
/*                                                                                */
/**********************************************************************************/

function Anchor(props: {
  onChangeEnd(): void
  onDeleteAnchor(): void
  onChange(type: 'position' | 'post' | 'pre', point: Vector): void
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
          onChange={(position, delta, event) => {
            props.onChange('pre', position)
            if (event.metaKey && props.post) {
              props.onChange(
                'post',
                vector.subtract(props.post, vector.multiply(delta, -1))
              )
            }
          }}
          onChangeEnd={props.onChangeEnd}
        />
      </Show>
      <Show when={props.post}>
        <Control
          position={props.position}
          control={props.post!}
          onChange={(position, delta, event) => {
            props.onChange('post', position)
            if (event.metaKey && props.pre) {
              props.onChange(
                'pre',
                vector.subtract(props.pre, vector.multiply(delta, -1))
              )
            }
          }}
          onChangeEnd={props.onChangeEnd}
        />
      </Show>
      <Handle
        position={props.position}
        onChange={(position) => props.onChange('position', position)}
        onChangeEnd={props.onChangeEnd}
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

function TimeIndicator(props: { height: number; time: number }) {
  const { project, getValue } = useTimeline()

  return (
    <g class={styles.timeIndicator}>
      <line y1={0} y2={props.height} x1={props.time} x2={props.time} />
      <circle cx={props.time} cy={project(getValue(props.time), 'y')!} r={3} />
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
  getValue(time: number): number
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

function Timeline(
  props: ComponentProps<'svg'> & {
    absoluteAnchors: Array<Anchor>
    addAnchor(time: number, value?: number): void
    deleteAnchor(index: number): void
    d(config?: { zoom?: Partial<Vector>; origin?: Partial<Vector> }): string
    getValue(time: number): number
    max: number
    min: number
    setAnchors: SetStoreFunction<Array<Anchor>>
    onOriginChange?(origin: Vector): void
    onTimeChange?(time: number): void
    onZoomChange?(zoom: Vector): void
    time?: number
    zoom?: Partial<Vector>
  }
) {
  const [, rest] = splitProps(props, [
    'min',
    'max',
    'onZoomChange',
    'onOriginChange',
    'absoluteAnchors',
    'd',
    'zoom',
    'time',
    'addAnchor',
    'deleteAnchor',
    'getValue',
    'setAnchors',
  ])
  const [domRect, setDomRect] = createSignal<DOMRect>()
  const [paddingMax, setPaddingMax] = createSignal(0)
  const [paddingMin, setPaddingMin] = createSignal(0)
  const [presence, setPresence] = createSignal<number | undefined>(undefined)

  const rangeHeight = () =>
    props.max + paddingMax() + paddingMin() - props.min * 2

  const zoom = whenMemo(
    domRect,
    (domRect) => ({
      x: 1,
      y: (domRect.height / rangeHeight()) * (props.zoom?.y || 1),
    }),
    { x: 1, y: 1 }
  )

  const origin = createMemo(() => ({
    x: 0,
    y: (paddingMin() - props.min) / (props.zoom?.y || 1),
  }))

  function project(point: Vector | number, type: 'x' | 'y') {
    const value = typeof point === 'object' ? point[type] : point
    return (value + origin()[type]) * zoom()[type]
  }

  function unproject(point: Vector | number, type: 'x' | 'y') {
    const value = typeof point === 'object' ? point[type] : point
    return (value - origin()[type]) / zoom()[type]
  }

  function onAnchorChange(
    type: 'pre' | 'post',
    index: number,
    position: Vector
  ) {
    const [point] = props.absoluteAnchors[index]
    const [connectedPoint] =
      type === 'post'
        ? props.absoluteAnchors[index + 1]
        : props.absoluteAnchors[index - 1]

    let absoluteX = unproject(position, 'x')

    // Clamp anchor w the connected point
    if (
      (type === 'post' && connectedPoint.x < absoluteX) ||
      (type !== 'post' && connectedPoint.x > absoluteX)
    ) {
      absoluteX = connectedPoint.x
    }

    // Clamp anchor w the current point
    if (
      (type === 'post' && absoluteX < point.x) ||
      (type !== 'post' && absoluteX > point.x)
    ) {
      absoluteX = point.x
    }

    const deltaX = Math.abs(point.x - connectedPoint.x)

    const anchor = {
      y: Math.floor(position.y - point.y),
      x: Math.abs(point.x - absoluteX) / deltaX,
    }

    props.setAnchors(index, 1, type, anchor)
  }

  function onPositionChange(index: number, position: Vector) {
    const [prev] = props.absoluteAnchors[index - 1] || []
    const [next] = props.absoluteAnchors[index + 1] || []

    // Clamp position w the previous anchor
    if (prev && position.x - 1 < prev.x) {
      position.x = prev.x + 1
    }
    // Clamp position w the next anchor
    if (next && position.x + 1 > next.x) {
      position.x = next.x - 1
    }

    props.setAnchors(index, 0, position)
  }

  function maxPaddingFromVector(value: Vector) {
    return Math.max(value.y, props.max) - props.max
  }
  function minPaddingFromVector(value: Vector) {
    return props.min - Math.min(value.y, props.min)
  }

  function updatePadding() {
    let min = 0
    let max = 0
    props.absoluteAnchors.forEach(([anchor, { pre, post } = {}]) => {
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
        origin,
        zoom,
        project,
        unproject,
        getValue: props.getValue,
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
          createEffect(() => props.onOriginChange?.(origin()))
        }}
        width="100%"
        height="100%"
        {...rest}
        onPointerMove={(e) => {
          setPresence(e.clientX)
        }}
        onPointerLeave={() => {
          setPresence(undefined)
        }}
        onDblClick={() => {
          const time = presence()
          if (time) props.addAnchor(time)
        }}
      >
        <path
          class={styles.path}
          d={props.d({ zoom: zoom(), origin: origin() })}
          style={{ 'pointer-events': 'none' }}
        />
        <Show when={!draggingHandle() && presence()}>
          {(presence) => (
            <TimeIndicator height={window.innerHeight} time={presence()} />
          )}
        </Show>
        <Show when={props.time}>
          {(time) => (
            <TimeIndicator height={window.innerHeight} time={time()} />
          )}
        </Show>
        <For each={props.absoluteAnchors}>
          {([point, { pre, post } = {}], index) => (
            <Anchor
              position={point}
              pre={pre}
              post={post}
              onDeleteAnchor={() => props.deleteAnchor(index())}
              onChange={(type, position) => {
                if (type === 'position') {
                  onPositionChange(index(), position)
                } else {
                  onAnchorChange(type, index(), position)
                }
              }}
              onChangeEnd={updatePadding}
            />
          )}
        </For>
        <line
          x1={0}
          x2={domRect()?.width}
          y1={project(props.max, 'y') - 1}
          y2={project(props.max, 'y') - 1}
          stroke="lightgrey"
        />
        <line
          x1={0}
          x2={domRect()?.width}
          y1={project(props.min, 'y') + 1}
          y2={project(props.min, 'y') + 1}
          stroke="lightgrey"
        />
        {props.children}
      </svg>
    </TimelineContext.Provider>
  )
}

/**********************************************************************************/
/*                                                                                */
/*                                 Create Timeline                                */
/*                                                                                */
/**********************************************************************************/

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
        controls.pre = vector.add(point, {
          x: deltaX * pre.x * -1,
          y: pre.y,
        })
      }

      const post = relativeControls?.post
      if (post) {
        const next = anchors[index + 1][0]
        const deltaX = next.x - point.x
        controls.post = vector.add(point, {
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
        if (index === -1) return
        anchors.splice(index, 0, [
          { x: time, y: value },
          { pre: { x: 0.5, y: 0 }, post: { x: 0.5, y: 0 } },
        ])
      })
    )
  }

  function deleteAnchor(index: number) {
    setAnchors(produce((anchors) => anchors.splice(index, 1)))
  }

  return {
    absoluteAnchors,
    anchors,
    d,
    getValue,
    setAnchors,
    deleteAnchor,
    addAnchor,
    Component: (
      props: Omit<
        ComponentProps<typeof Timeline>,
        | 'absoluteAnchors'
        | 'addAnchor'
        | 'd'
        | 'getValue'
        | 'setAnchors'
        | 'deleteAnchor'
      >
    ) => (
      <Timeline
        absoluteAnchors={absoluteAnchors()}
        addAnchor={addAnchor}
        d={d}
        deleteAnchor={deleteAnchor}
        getValue={getValue}
        setAnchors={setAnchors}
        {...props}
      />
    ),
  }
}
