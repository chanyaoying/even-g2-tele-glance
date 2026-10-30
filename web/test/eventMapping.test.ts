import { describe, expect, it, vi } from 'vitest'
import { createBoundedInputDispatcher, createInputCoalescer, mapEvenHubEvent } from '../src/bridge/eventMapping'

describe('mapEvenHubEvent', () => {
  it('maps press, double press, and swipes from text events', () => {
    expect(mapEvenHubEvent({ textEvent: { eventType: undefined } })).toEqual({ type: 'press' })
    expect(mapEvenHubEvent({ textEvent: { eventType: 3 } })).toEqual({ type: 'doublePress' })
    expect(mapEvenHubEvent({ textEvent: { eventType: 'DOUBLE_CLICK_EVENT' } })).toEqual({ type: 'doublePress' })
    expect(mapEvenHubEvent({ textEvent: { eventType: 1 } })).toEqual({ type: 'swipeUp' })
    expect(mapEvenHubEvent({ textEvent: { eventType: 2 } })).toEqual({ type: 'swipeDown' })
  })

  it('maps long press and its release from every payload shape', () => {
    expect(mapEvenHubEvent({ textEvent: { eventType: 9 } })).toEqual({ type: 'longPress' })
    expect(mapEvenHubEvent({ textEvent: { eventType: 10 } })).toEqual({ type: 'longPressRelease' })
    expect(mapEvenHubEvent({ sysEvent: { eventType: 'LONG_PRESS_EVENT' } })).toEqual({ type: 'longPress' })
    expect(mapEvenHubEvent({ sysEvent: { eventType: 'LONG_PRESS_RELEASE_EVENT' } })).toEqual({ type: 'longPressRelease' })
    expect(mapEvenHubEvent({ jsonData: { eventType: 9 } })).toEqual({ type: 'longPress' })
  })

  it('maps list selection and audio chunks', () => {
    expect(mapEvenHubEvent({ listEvent: { currentSelectItemIndex: 2 } })).toEqual({ type: 'selectIndex', index: 2 })
    expect(mapEvenHubEvent({ listEvent: { eventType: 0, currentSelectItemIndex: 2 } })).toEqual({ type: 'press', index: 2 })
    expect(mapEvenHubEvent({ listEvent: { eventType: 3, currentSelectItemIndex: 2 } })).toEqual({ type: 'doublePress', index: 2 })
    expect(mapEvenHubEvent({ listEvent: { currentSelectItemName: 'Project' } })).toEqual({ type: 'selectIndex', itemName: 'Project' })
    expect(mapEvenHubEvent({ listEvent: { eventType: 0, currentSelectItemName: 'Project' } })).toEqual({ type: 'press', itemName: 'Project' })
    expect(mapEvenHubEvent({ audioEvent: { audioPcm: [1, 2, 3] } })).toEqual({
      type: 'audioChunk',
      pcm: new Uint8Array([1, 2, 3]),
    })
  })

  it('maps raw hardware/protobuf-shaped event payloads', () => {
    expect(
      mapEvenHubEvent({
        type: 'list_event',
        jsonData: { Event_Type: 'PRESS', CurrentSelect_ItemIndex: '3' },
      }),
    ).toEqual({ type: 'press', index: 3 })
    expect(
      mapEvenHubEvent({
        type: 'list_event',
        jsonData: { Event_Type: 'PRESS', CurrentSelect_ItemName: 'Project' },
      }),
    ).toEqual({ type: 'press', itemName: 'Project' })
    expect(
      mapEvenHubEvent({
        type: 'listEvent',
        data: { event_type: 'DOUBLE_PRESS', current_select_item_index: '1' },
      }),
    ).toEqual({ type: 'doublePress', index: 1 })
    expect(mapEvenHubEvent({ textEvent: { Event_Type: 'SWIPE_UP' } })).toEqual({ type: 'swipeUp' })
    expect(mapEvenHubEvent({ textEvent: { eventType: '2' } })).toEqual({ type: 'swipeDown' })
  })

  it('maps gesture event types from system events like even-toolkit', () => {
    expect(mapEvenHubEvent({ sysEvent: { eventType: 0 } })).toEqual({ type: 'press' })
    expect(mapEvenHubEvent({ sysEvent: { eventType: 3 } })).toEqual({ type: 'doublePress' })
    expect(mapEvenHubEvent({ sysEvent: { eventType: 1 } })).toEqual({ type: 'swipeUp' })
    expect(mapEvenHubEvent({ sysEvent: { eventType: 2 } })).toEqual({ type: 'swipeDown' })
  })

  it('keeps raw jsonData eventType when SDK-normalized sysEvent omits it', () => {
    // The raw eventSource is preserved so the controller can distinguish
    // idle system doublePress events (eventSource === 1) from genuine
    // user double-presses. See AGENTS.md "Idle doublePress events...".
    expect(
      mapEvenHubEvent({
        jsonData: { eventType: 3, eventSource: 2 },
        sysEvent: { eventSource: 2 },
      }),
    ).toEqual({ type: 'doublePress', eventSource: 2 })
  })

  it('preserves eventSource on press / doublePress / swipe so the controller can filter idle system events', () => {
    // AGENTS.md "Idle doublePress events on the G2 / simulator can mimic
    // user input" — the controller drops the awake↔asleep bounce when
    // eventSource === 1 and the last user input is older than 1s.
    expect(mapEvenHubEvent({ sysEvent: { eventType: 3, eventSource: 1 } })).toEqual({ type: 'doublePress', eventSource: 1 })
    expect(mapEvenHubEvent({ sysEvent: { eventType: 0, eventSource: 2 } })).toEqual({ type: 'press', eventSource: 2 })
    expect(mapEvenHubEvent({ textEvent: { eventType: 1, eventSource: 1 } })).toEqual({ type: 'swipeUp', eventSource: 1 })
    expect(mapEvenHubEvent({ jsonData: { eventType: 3, eventSource: 1 } })).toEqual({ type: 'doublePress', eventSource: 1 })
    // String-encoded source values are tolerated for parity with proto
    // payloads that arrive with quoted integers.
    expect(mapEvenHubEvent({ sysEvent: { eventType: 3, eventSource: '1' } })).toEqual({ type: 'doublePress', eventSource: 1 })
    // When the raw event carries no eventSource, the AppInput omits the
    // field so callers that test exact equality stay simple.
    expect(mapEvenHubEvent({ sysEvent: { eventType: 3 } })).toEqual({ type: 'doublePress' })
  })
  it('debounces duplicate click payloads instead of synthesizing double press', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput, 250)

    coalesce({ type: 'press' })
    coalesce({ type: 'press' })

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith({ type: 'press' })
    vi.useRealTimers()
  })

  it('emits a single press immediately', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput, 250)

    coalesce({ type: 'press' })

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith({ type: 'press' })
    vi.useRealTimers()
  })
  it('debounces duplicate double press payloads', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput, 250)

    coalesce({ type: 'doublePress' })
    coalesce({ type: 'doublePress' })

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith({ type: 'doublePress' })
    vi.useRealTimers()
  })

  it('allows a native double press shortly after a press payload', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput, 90, 220)

    coalesce({ type: 'press' })
    vi.advanceTimersByTime(80)
    coalesce({ type: 'doublePress' })

    expect(onInput).toHaveBeenCalledTimes(2)
    expect(onInput).toHaveBeenNthCalledWith(1, { type: 'press' })
    expect(onInput).toHaveBeenNthCalledWith(2, { type: 'doublePress' })
    vi.useRealTimers()
  })

  it('debounces duplicate same-direction swipe bursts', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput, 90, 220, 250)

    coalesce({ type: 'swipeUp' })
    coalesce({ type: 'swipeUp' })
    coalesce({ type: 'swipeDown' })
    vi.advanceTimersByTime(251)
    coalesce({ type: 'swipeUp' })

    expect(onInput).toHaveBeenCalledTimes(3)
    expect(onInput).toHaveBeenNthCalledWith(1, { type: 'swipeUp' })
    expect(onInput).toHaveBeenNthCalledWith(2, { type: 'swipeDown' })
    expect(onInput).toHaveBeenNthCalledWith(3, { type: 'swipeUp' })
    vi.useRealTimers()
  })

  it('debounces bursty same-direction swipes with the default debounce', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput)

    coalesce({ type: 'swipeDown' })
    vi.advanceTimersByTime(20)
    coalesce({ type: 'swipeDown' })

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenNthCalledWith(1, { type: 'swipeDown' })
    vi.useRealTimers()
  })

  it('keeps deliberate repeated same-direction swipes with the default debounce', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const coalesce = createInputCoalescer(onInput)

    coalesce({ type: 'swipeDown' })
    vi.advanceTimersByTime(31)
    coalesce({ type: 'swipeDown' })

    expect(onInput).toHaveBeenCalledTimes(2)
    expect(onInput).toHaveBeenNthCalledWith(1, { type: 'swipeDown' })
    expect(onInput).toHaveBeenNthCalledWith(2, { type: 'swipeDown' })
    vi.useRealTimers()
  })

  it('keeps only the latest gesture from a burst-delivered SDK input batch', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const dispatch = createBoundedInputDispatcher(onInput)

    dispatch({ type: 'press' })
    dispatch({ type: 'swipeDown' })
    dispatch({ type: 'doublePress' })
    vi.advanceTimersByTime(20)

    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith({ type: 'doublePress' })
    vi.useRealTimers()
  })

  it('starts a new bounded batch after the dispatch window', () => {
    vi.useFakeTimers()
    const onInput = vi.fn()
    const dispatch = createBoundedInputDispatcher(onInput, 20)

    dispatch({ type: 'press' })
    vi.advanceTimersByTime(20)
    dispatch({ type: 'swipeDown' })
    vi.advanceTimersByTime(20)

    expect(onInput).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
