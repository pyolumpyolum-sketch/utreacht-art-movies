const form = document.querySelector("#date-form");
const dateInput = document.querySelector("#date");
const statusEl = document.querySelector("#status");
const updatedEl = document.querySelector("#updated");
const resultsEl = document.querySelector("#results");
const template = document.querySelector("#movie-template");

const today = new Date();
const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
  .toISOString()
  .slice(0, 10);

dateInput.value = localToday;

function formatDate(date) {
  return new Intl.DateTimeFormat("en-NL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function setLoading(isLoading) {
  form.querySelector("button").disabled = isLoading;
  dateInput.disabled = isLoading;
}

function renderEmpty(date) {
  resultsEl.innerHTML = "";
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = `No showtimes found for ${formatDate(date)} in Springhaver, Louis Hartlooper, or Slachtstraat.`;
  resultsEl.append(empty);
}

function renderMovies(data) {
  resultsEl.innerHTML = "";

  for (const movie of data.movies) {
    const card = template.content.firstElementChild.cloneNode(true);
    const title = card.querySelector(".movie-title");
    const theater = card.querySelector(".theater");
    const times = card.querySelector(".times");

    title.textContent = movie.movie;
    title.href = movie.source;
    theater.textContent = movie.theater;

    for (const showtime of movie.times) {
      const link = document.createElement("a");
      link.className = "time-link";
      link.href = showtime.ticketUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = showtime.time;
      link.ariaLabel = `${movie.movie} at ${showtime.time}, ${movie.theater}`;
      times.append(link);
    }

    resultsEl.append(card);
  }
}

async function loadShowtimes(date) {
  setLoading(true);
  statusEl.textContent = `Loading ${formatDate(date)}...`;
  updatedEl.textContent = "";
  resultsEl.innerHTML = "";

  try {
    const response = await fetch(`/api/showtimes?date=${encodeURIComponent(date)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load showtimes.");
    }

    const warningText = data.warnings?.length ? `, with ${data.warnings.length} source warning${data.warnings.length === 1 ? "" : "s"}` : "";
    statusEl.textContent = `${data.movies.length} movie listing${data.movies.length === 1 ? "" : "s"} for ${formatDate(date)}${warningText}`;
    updatedEl.textContent = `Updated ${new Intl.DateTimeFormat("en-NL", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(data.fetchedAt))}`;

    if (data.movies.length === 0) {
      renderEmpty(date);
    } else {
      renderMovies(data);
    }
  } catch (error) {
    resultsEl.innerHTML = "";
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = error.message;
    resultsEl.append(message);
    statusEl.textContent = "Schedule unavailable";
  } finally {
    setLoading(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadShowtimes(dateInput.value);
});

loadShowtimes(dateInput.value);
