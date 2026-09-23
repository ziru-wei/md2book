---
created: 2026-09-21
updated: 2026-09-22
publishID: test
---
> Proactivity should not be modeled as a sequence of interventions/messages. It can be represented as a continuously evolving spatial-temporal state with laten actionalbility that inhabits the physical taskscape. 

**Today’s proactive assistants continuously infer, but discretely intervene.**  
**We explore proactivity as a continuous spatial-temporal state embedded in the physical taskscape.**  
Rather than deciding only whether and when to interrupt, multiple inferred opportunities **emerge**, **strengthen**, **recede**, and **disappear** around the objects and places to which they matter.


- **continuous**, **spatial-temporal** proactivity that inhabit in the physical environment
	- ==why the mono-channel of audio assistant is not good enough?==
		- it's one-shot, foreground, competing for attention
			- -->limit the possibility of **multiple simultaneous proactivities**; but they should be multiple low-bandwidth hypotheses coexist spatially
			- --> listen-react will waste the time that the proactive computational system saves. but glance-notice leverage the physical world's affordance and familiarity, spatially distributed proactivity can bring the mental mode directly to the physical area and the task-scape -- leveraging the natural connection
		- the say-or-not pattern will cause the information loss since the binary proactive system captures less nuances than the dynamic continuous proactivity estimation system
			- can attune to more things, but no burdetnn load -- and that's exactly the value of periphery: maintain more awareness of the surround while not asking for more focused attention
			- more transparent. Satori's interview mentions this.
	- ==what's the differences between the conventional AR notification and spatially distributed proactivity in AR?==
		- for the inferred proactivity, human user may not have the expectation. so a red indicator dot is not enough.
		- need to understand the taxonomy of proactive ar assistance better
	- ==design space?==
		- from timing towards "lifecycle": a new aspect/challenge is WHEN TO DISAPPESAR--- proactive disappear --> proactively maintain the lifecycle
		- modality combination
			- visual(ref to traditional ar widget)
			- audio
			- form(a question? a nuedge?...)

available without demanding action
- [ ] object nesting?

---

Compact context:

- Core idea: **proactivity should not be only discrete interventions**. We are exploring **continuous, spatial-temporal proactive proposals** that can inhabit the physical taskscape, emerge/recede over time, and coexist without always interrupting the user.
    
- AR is primarily the **representation / negotiation layer** for these proactive proposals. The underlying proposal may be informational, computational, virtual, or physical; AR makes it spatially legible before/while the user engages with it.
    
- The taxonomy is not a progression. Its purpose is **case generation**: pick qualitatively different proactive proposal types, then test whether one representation framework can generalize across them.
    
- Current taxonomy:
    
    1. **Object / entity relevance** — “this thing matters.”  
        e.g. take passport, use this screwdriver.
        
    2. **State / condition awareness** — “this condition matters.”  
        e.g. pan overheating, part misaligned.
        
    3. **Action / operation suggestion** — “you should do this.”  
        e.g. replace filter, tighten bolt.
        
    4. **Assist proposal** — system contributes to the user’s ongoing activity; user remains primary actor.  
        Virtual: start timer. Physical: turn off stove, hold board.
        
    5. **Automation / delegation proposal** — system takes ownership of a task/subtask and user can disengage.  
        Virtual: send email. Physical: clean yard.
        
- Clean distinction for the last three:  
    **suggestion = you do it**  
    **assist = we do it together / system contributes**  
    **automation = system does it for you**
    

Next phase should be about selecting representative cases from these categories that best stress-test the continuous AR representation.


You are making dinner while pasta is boiling, something is in the oven, and vegetables are on the cutting board. Nothing constantly talks to you. Instead, the kitchen quietly changes around you: 
	- the pot that will need attention soon becomes a little more noticeable, 
	- a timer lives beside the oven, 
	- an ingredient you are about to need becomes easier to spot, 
- and each cue fades again when it no longer matters.

You are sitting at your computer browsing, writing, or watching a video. On the other side of the desk, your ice cream is slowly melting. It is not important enough for an alarm, but it is becoming increasingly time-sensitive. At first there is almost nothing; as it melts, the cue around the ice cream gradually becomes harder to miss. You notice it in your peripheral in a micro-break in your browsing, and eat the icecream. when your hand approach to the icecream, the proactive indicator gradually disappears.

 you closed your laptop and started packing your bag. As your intention to leave becomes clearer, things distributed around the room quietly become relevant: your keys near the shelf, the return package by the door, your passport on the desk because you are traveling tomorrow. They do not appear as a checklist all at once. Each one emerges only when the moment, place, and your behavior make it useful. meanwhile, system suggest the robot clean the room when you are not around.

