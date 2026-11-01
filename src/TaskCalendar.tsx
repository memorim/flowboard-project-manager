import type { Task } from './types';

export function TaskCalendar({
  month,
  tasks,
  onOpen,
}: {
  month: string;
  tasks: Task[];
  onOpen: (task: Task) => void;
}) {
  const first = new Date(`${month}-01T12:00:00`);
  const last = new Date(first);
  last.setMonth(last.getMonth() + 1);
  last.setDate(0);
  const offset = (first.getDay() + 6) % 7;
  const cells = Math.ceil((offset + last.getDate()) / 7) * 7;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return (
    <div className="calendar-scroll" role="region" aria-label="Календарь задач" tabIndex={0}>
      <table className="calendar-grid">
        <caption>{first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</caption>
        <thead>
          <tr>
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => (
              <th scope="col" key={day}>
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: cells / 7 }, (_, week) => (
            <tr key={week}>
              {Array.from({ length: 7 }, (_, weekday) => {
                const day = week * 7 + weekday - offset + 1;
                if (day < 1 || day > last.getDate())
                  return <td className="calendar-empty" key={weekday} />;
                const date = `${month}-${String(day).padStart(2, '0')}`;
                return (
                  <td
                    key={weekday}
                    data-date={date}
                    className={date === today ? 'calendar-today' : ''}
                  >
                    <time dateTime={date} aria-current={date === today ? 'date' : undefined}>
                      {day}
                    </time>
                    {tasks
                      .filter((task) => task.due_date === date)
                      .map((task) => (
                        <button
                          key={task.id}
                          className={`calendar-task calendar-${task.status}`}
                          onClick={() => onOpen(task)}
                        >
                          {task.title}
                          <small>{task.project_name}</small>
                        </button>
                      ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
