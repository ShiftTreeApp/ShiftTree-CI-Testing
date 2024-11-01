import { Request, Response } from "express";
import { z } from "zod";
import * as jwt from "jsonwebtoken";

import { pool } from "@/pool";

const tokenPayload = z.object({ email: z.string(), name: z.string() });

export async function create(req: Request, res: Response) {
  const userId = await getUserId(req);

  const scheduleInfo = req.body as {
    name: string;
    description?: string | null;
  };

  const result = await pool.query({
    text: /* sql */ `
      insert into schedule (owner_id, schedule_name, schedule_description)
      values ($1, $2, $3)
      returning id
    `,
    values: [userId, scheduleInfo.name, scheduleInfo.description],
  });
  if (result.rows.length < 1) {
    console.error("Failed to create schedule");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const scheduleId = result.rows[0].id as string;
  res.status(201).json({ scheduleId });
}

const listParams = z.object({
  role: z.array(z.enum(["owner", "member", "manager"])),
});

async function getUserId(req: Request) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    throw new Error("Missing token");
  }
  const decoded = tokenPayload.parse(
    jwt.verify(token, process.env.SHIFTTREE_JWT_PK as string),
  );

  const query = /* sql */ `
    SELECT u.id
    FROM user_account AS u
    WHERE u.email = $1
  `;
  const result = await pool.query({
    text: query,
    values: [decoded.email],
  });
  return result.rows[0].id as string;
}

export async function list(req: Request, res: Response) {
  const params = listParams.parse(req.query);
  const userId = await getUserId(req);

  const query = /* sql */ `
    with filtered as (
      select info.*, se.start_time, se.end_time
      from schedule_info as info
      join schedule_start_end as se on info.schedule_id = se.schedule_id
      where true
        and info.user_id = $1
        and info.user_role in (select json_array_elements($2) #>> '{}' as r)
      order by se.start_time asc, info.schedule_name asc
    )
    select coalesce(json_agg(json_build_object(
      'id', s.schedule_id,
      'name', s.schedule_name,
      'description', '',
      'owner', (
        select json_build_object(
          'id', ua.id,
          'displayName', ua.username,
          'email', ua.email,
          'profileImageUrl', '' -- TODO: Add profile image url
        )
        from user_account as ua
        where ua.id = s.owner_id
      ),
      'role', s.user_role,
      'startTime', (to_json(s.start_time)#>>'{}')||'Z', -- converting to ISO 8601 time
      'endTime', (to_json(s.end_time)#>>'{}')||'Z',
      'state', 'open'
    )), json_array()) as json
    from filtered as s
  `;

  const result = await pool.query({
    text: query,
    values: [userId, JSON.stringify(Array.from(new Set(params.role)))],
  });

  res.json(result.rows[0].json);
}

export async function getSchedule(req: Request, res: Response) {
  const scheduleId = req.params.scheduleId;
  const userId = await getUserId(req);

  const query = /* sql */ `
    with selected_schedule as (
      select info.*, se.start_time, se.end_time
      from schedule_info as info
      join schedule_start_end as se on info.schedule_id = se.schedule_id
      where info.user_id = $1 and info.schedule_id = $2
    )
    select json_build_object(
      'id', s.schedule_id,
      'name', s.schedule_name,
      'description', '',
      'owner', (
        select json_build_object(
          'id', ua.id,
          'displayName', ua.username,
          'email', ua.email,
          'profileImageUrl', '' -- TODO: Add profile image url
        )
        from user_account as ua
        where ua.id = s.owner_id
      ),
      'role', s.user_role,
      'startTime', (to_json(s.start_time)#>>'{}')||'Z', -- converting to ISO 8601 time
      'endTime', (to_json(s.end_time)#>>'{}')||'Z',
      'state', 'open'
    ) as json
    from selected_schedule as s
  `;

  const results = await pool.query({
    text: query,
    values: [userId, scheduleId],
  });

  if (results.rows.length < 1) {
    res.status(404).json({ error: "Schedule not found" });
  } else {
    res.status(200).json(results.rows[0].json);
  }
}

export async function deleteSchedule(req: Request, res: Response) {
  const userId = await getUserId(req);
  const scheduleId = req.params.scheduleId as string;

  const schedulesQuery = /* sql */ `
    select * from schedule_info
    where schedule_info.user_id = $1 and schedule_info.schedule_id = $2
  `;

  const schedulesResult = await pool.query({
    text: schedulesQuery,
    values: [userId, scheduleId],
  });

  if (schedulesResult.rows.length < 1) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  const schedule = schedulesResult.rows[0];

  if (!(schedule.user_role === "owner" || schedule.user_role === "manager")) {
    res
      .status(403)
      .json({ error: "You do not have permission to delete this schedule" });
    return;
  }

  await pool.query({
    text: /* sql */ `
      update schedule
      set removed = current_timestamp
      where id = $1
    `,
    values: [scheduleId],
  });

  res.status(204).send();
}

export async function getShifts(req: Request, res: Response) {
  const userId = await getUserId(req);
  const scheduleId = req.params.scheduleId as string;

  // Check that user can access the schedule
  {
    const results = await pool.query({
      text: /* sql */ `
        select *
        from schedule_info as info
        where info.user_id = $1 and info.schedule_id = $2
      `,
      values: [userId, scheduleId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
  }

  const results = await pool.query({
    text: /* sql */ `
      with sorted as
      (
        select *
        from shift as s
        where s.schedule_id = $1
        order by s.start_time asc
      )
      select json_agg(json_build_object(
        'id', s.id,
        'name', '', -- TODO: Add shift name to the schema
        'startTime', (to_json(s.start_time)#>>'{}')||'Z', -- converting to ISO 8601 time
        'endTime', (to_json(s.end_time)#>>'{}')||'Z'
      )) as json
      from sorted as s
    `,
    values: [scheduleId],
  });

  res.status(200).json(results.rows[0].json);
}

export async function createShift(req: Request, res: Response) {
  const userId = await getUserId(req);
  const scheduleId = req.params.scheduleId as string;

  // Check that user can access the schedule and has permission to create shifts
  {
    const results = await pool.query({
      text: /* sql */ `
        select *
        from schedule_info as info
        where info.user_id = $1 and info.schedule_id = $2
      `,
      values: [userId, scheduleId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }

    const role = results.rows[0].user_role;

    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error: "You do not have permission to create shifts for this schedule",
      });
      return;
    }
  }

  const results = await pool.query({
    text: /* sql */ `
      insert into shift (schedule_id, start_time, end_time)
      values ($1, $2, $3)
      returning json_build_object(
        'id', shift.id,
        'name', '', -- TODO: Add shift name to the schema
        'startTime', (to_json(shift.start_time)#>>'{}')||'Z', -- converting to ISO 8601 time
        'endTime', (to_json(shift.end_time)#>>'{}')||'Z'
      ) as json
    `,
    values: [scheduleId, req.body.startTime, req.body.endTime],
  });

  res.status(201).json(results.rows[0].json);
}

export async function getMembers(req: Request, res: Response) {
  const userId = await getUserId(req);
  const scheduleId = req.params.scheduleId as string;

  // Check that user can access the schedule
  {
    const results = await pool.query({
      text: /* sql */ `
        select * from schedule_info as info
        where info.user_id = $1 and info.schedule_id = $2
      `,
      values: [userId, scheduleId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }

    // TODO: Allow for members to view other members if the permission is set
    const role = results.rows[0].user_role;
    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error: "You do not have permission to view members of this schedule",
      });
      return;
    }
  }

  const results = await pool.query({
    text: /* sql */ `
      select json_agg(json_build_object(
        'id', ua.id,
        'displayName', ua.username,
        'email', ua.email,
        'profileImageUrl', ''
      )) as json
      from user_schedule_membership as usm
      join user_account as ua on usm.user_id = ua.id
      where usm.schedule_id = $1
    `,
    values: [scheduleId],
  });

  res.status(200).json(results.rows[0].json);
}

export async function getSignups(req: Request, res: Response) {
  const userId = await getUserId(req);
  const scheduleId = req.params.scheduleId as string;

  // Check that user can access the schedule
  {
    const results = await pool.query({
      text: /* sql */ `
        select * from schedule_info as info
        where info.user_id = $1 and info.schedule_id = $2
      `,
      values: [userId, scheduleId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error: "You do not have permission to view signups for this schedule",
      });
      return;
    }
  }

  const results = await pool.query({
    text: /* sql */ `
      select json_agg(json_build_object(
        'id', shift.id,
        'name', '',
        'description', '',
        'startTime', (to_json(shift.start_time)#>>'{}')||'Z', -- converting to ISO 8601 time
        'endTime', (to_json(shift.end_time)#>>'{}')||'Z',
        'signups', (
          select coalesce(json_agg(json_build_object(
            'id', signup.id,
            'weight', signup.user_weighting,
            'user', json_build_object(
              'id', ua.id,
              'displayName', ua.username,
              'email', ua.email,
              'profileImageUrl', ''
            )
          )), json_array())
          from user_shift_signup as signup
          join user_account as ua on signup.user_id = ua.id
          where signup.shift_id = shift.id
        )
      )) as json
      from shift
      join schedule on shift.schedule_id = schedule.id
      where schedule.id = $1
    `,
    values: [scheduleId],
  });

  res.status(200).json(results.rows[0].json);
}

export async function deleteShift(req: Request, res: Response) {
  const userId = await getUserId(req);
  const shiftId = req.params.shiftId as string;

  // Check that user can access the shift
  {
    const results = await pool.query({
      text: /* sql */ `
        select *
        from shift
        join schedule_info as info on shift.schedule_id = info.schedule_id
        where info.user_id = $1 and shift.id = $2
      `,
      values: [userId, shiftId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error: "You do not have permission to delete this shift",
      });
      return;
    }
  }

  await pool.query({
    text: /* sql */ `
      delete from shift
      where id = $1
    `,
    values: [shiftId],
  });

  res.status(204).send();
}

export async function editShift(req: Request, res: Response) {
  const userId = await getUserId(req);
  const shiftId = req.params.shiftId as string;

  // TODO: Validate that the start date is before the end date

  // Check that user can access the shift
  {
    const results = await pool.query({
      text: /* sql */ `
        select *
        from shift
        join schedule_info as info on shift.schedule_id = info.schedule_id
        where info.user_id = $1 and shift.id = $2
      `,
      values: [userId, shiftId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error: "You do not have permission to edit this shift",
      });
      return;
    }
  }

  await pool.query({
    text: /* sql */ `
      update shift
      set start_time = $1, end_time = $2
      where id = $3
    `,
    values: [req.body.startTime, req.body.endTime, shiftId],
  });

  res.status(204).send();
}

export async function addSignup(req: Request, res: Response) {
  const userId = await getUserId(req);
  const shiftId = req.params.shiftId as string;
  const targetUserId = req.body.userId as string | null;
  const weight = req.body.weight as number | null;

  // If target user is specified, check that the current user has permission to sign users up in the schedule
  // and that the target user is a member of the schedule
  if (targetUserId && targetUserId !== userId) {
    const results = await pool.query({
      text: /* sql */ `
          select info.user_role
          from schedule_info as info
          join shift on info.schedule_id = shift.schedule_id
          join user_schedule_membership as usm on info.schedule_id = usm.schedule_id
          where info.user_id = $1 and shift.id = $2
        `,
      values: [userId, shiftId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error: "You do not have permission to sign users up for this shift",
      });
      return;
    }

    // Ensure target user is a member of the schedule
    const targetUserResults = await pool.query({
      text: /* sql */ `
          select info.user_role
          from schedule_info as info
          join shift on info.schedule_id = shift.schedule_id
          where info.user_id = $1
        `,
      values: [targetUserId],
    });

    if (
      targetUserResults.rows.length < 1 ||
      targetUserResults.rows[0].user_role !== "member"
    ) {
      res.status(400).json({
        error: "Target user does not exist or is not a member of the schedule",
      });
      return;
    }
  } else {
    // Ensure that the current user is a member of the schedule
    const results = await pool.query({
      text: /* sql */ `
        select info.user_role
        from schedule_info as info
        join shift on info.schedule_id = shift.schedule_id
        where info.user_id = $1 and shift.id = $2
      `,
      values: [userId, shiftId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (role !== "member") {
      res.status(403).json({
        error: "You are not allowed to sign up for this shift",
      });
      return;
    }
  }

  await pool.query({
    text: /* sql */ `
      insert into user_shift_signup (user_id, shift_id, user_weighting)
      values ($1, $2, $3)
      on conflict do nothing
    `,
    values: [targetUserId ?? userId, shiftId, weight ?? 1],
  });

  res.status(204).send();
}

export async function deleteSignup(req: Request, res: Response) {
  const userId = await getUserId(req);
  const shiftId = req.params.shiftId as string;
  const targetUserId = req.query.userId as string | null;

  // If target user is specified, check that the current user has permission to sign users up in the schedule
  // and that the target user is a member of the schedule
  if (targetUserId && targetUserId !== userId) {
    const results = await pool.query({
      text: /* sql */ `
          select info.user_role
          from schedule_info as info
          join shift on info.schedule_id = shift.schedule_id
          join user_schedule_membership as usm on info.schedule_id = usm.schedule_id
          where info.user_id = $1 and shift.id = $2
        `,
      values: [userId, shiftId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (!(role === "owner" || role === "manager")) {
      res.status(403).json({
        error:
          "You do not have permission to remove other users from this shift",
      });
      return;
    }

    // Ensure target user is a member of the schedule
    const targetUserResults = await pool.query({
      text: /* sql */ `
          select info.user_role
          from schedule_info as info
          join shift on info.schedule_id = shift.schedule_id
          where info.user_id = $1
        `,
      values: [targetUserId],
    });

    if (
      targetUserResults.rows.length < 1 ||
      targetUserResults.rows[0].user_role !== "member"
    ) {
      res.status(400).json({
        error: "Target user does not exist or is not a member of the schedule",
      });
      return;
    }
  } else {
    // Ensure that the current user is a member of the schedule
    const results = await pool.query({
      text: /* sql */ `
        select info.user_role
        from schedule_info as info
        join shift on info.schedule_id = shift.schedule_id
        where info.user_id = $1 and shift.id = $2
      `,
      values: [userId, shiftId],
    });

    if (results.rows.length < 1) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }

    const role = results.rows[0].user_role;
    if (role !== "member") {
      res.status(403).json({
        error: "You are not allowed to give up this shift",
      });
      return;
    }
  }

  await pool.query({
    text: /* sql */ `
      delete from user_shift_signup
      where user_id = $1 and shift_id = $2
    `,
    values: [targetUserId ?? userId, shiftId],
  });

  res.status(204).send();
}
